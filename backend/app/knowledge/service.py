"""Document parsing, chunking, indexing and permission-aware retrieval.

Retrieval is hybrid: Postgres full-text search always; pgvector cosine similarity when the
knowledge base has an embedding provider. Permissions are enforced in SQL by restricting to the
knowledge bases the agent is explicitly allowed to read.
"""

import csv
import io
import re
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import delete, func, literal_column, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..llm.service import provider_from_row
from ..models import DocumentChunk, KnowledgeBase, LLMProvider

SUPPORTED = {
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".csv": "text/csv",
    ".json": "application/json",
    ".html": "text/html",
}


class UnsupportedDocument(ValueError):
    pass


def extract_text(filename: str, data: bytes) -> str:
    ext = ("." + filename.rsplit(".", 1)[-1].lower()) if "." in filename else ""
    if ext not in SUPPORTED:
        raise UnsupportedDocument(f"Unsupported file type '{ext or filename}'. Supported: {', '.join(SUPPORTED)}")
    if ext == ".pdf":
        from pypdf import PdfReader

        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            raise UnsupportedDocument("Encrypted PDFs are not supported")
        return "\n\n".join((p.extract_text() or "") for p in reader.pages[:2000])
    if ext == ".docx":
        from docx import Document as Docx

        d = Docx(io.BytesIO(data))
        parts = [p.text for p in d.paragraphs]
        for table in d.tables:
            parts.extend(" | ".join(c.text for c in row.cells) for row in table.rows)
        return "\n".join(parts)
    text = data.decode("utf-8", errors="replace")
    if ext == ".csv":
        rows = list(csv.reader(io.StringIO(text)))
        if not rows:
            return ""
        header, body = rows[0], rows[1:]
        return "\n".join("; ".join(f"{h}: {v}" for h, v in zip(header, r, strict=False)) for r in body)
    if ext == ".html":
        text = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", text, flags=re.S | re.I)
        text = re.sub(r"<[^>]+>", " ", text)
    return text


def chunk_text(text: str, size: int = 1200, overlap: int = 150) -> list[str]:
    """Paragraph-aware chunking with overlap."""
    text = re.sub(r"[ \t]+", " ", text).strip()
    paras = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    chunks: list[str] = []
    cur = ""
    for p in paras:
        while len(p) > size:  # hard-split very long paragraphs
            head, p = p[:size], p[size - overlap:]
            if cur:
                chunks.append(cur)
                cur = ""
            chunks.append(head)
        if len(cur) + len(p) + 2 <= size:
            cur = f"{cur}\n\n{p}" if cur else p
        else:
            if cur:
                chunks.append(cur)
            tail = cur[-overlap:] if cur else ""
            cur = f"{tail}\n\n{p}" if tail else p
    if cur:
        chunks.append(cur)
    return chunks


async def index_document(db: AsyncSession, *, org_id: UUID, kb: KnowledgeBase, document_id: UUID,
                         text: str) -> int:
    await db.execute(delete(DocumentChunk).where(DocumentChunk.document_id == document_id))
    chunks = chunk_text(text)
    embeddings: list[list[float]] | None = None
    if kb.embedding_provider_id and chunks:
        prov = await db.get(LLMProvider, kb.embedding_provider_id)
        if prov and prov.embedding_model:
            p = provider_from_row(prov)
            embeddings = []
            for i in range(0, len(chunks), 64):
                embeddings.extend(await p.embed(chunks[i:i + 64], prov.embedding_model))
    db.add_all(
        DocumentChunk(org_id=org_id, kb_id=kb.id, document_id=document_id, idx=i, content=c,
                      embedding=embeddings[i] if embeddings else None)
        for i, c in enumerate(chunks)
    )
    return len(chunks)


@dataclass(slots=True)
class Hit:
    document_id: UUID
    filename: str
    chunk_idx: int
    content: str
    score: float


async def retrieve(db: AsyncSession, *, org_id: UUID, kb_ids: list[UUID], query: str, k: int = 5) -> list[Hit]:
    from ..models import Document

    if not kb_ids or not query.strip():
        return []
    words = re.findall(r"\w{3,}", query.lower())[:40]
    if not words:
        return []
    tsq = func.to_tsquery("simple", " | ".join(dict.fromkeys(words)))
    rank = func.ts_rank_cd(DocumentChunk.tsv, tsq).label("score")
    base = (
        select(DocumentChunk.document_id, Document.filename, DocumentChunk.idx, DocumentChunk.content, rank)
        .join(Document, Document.id == DocumentChunk.document_id)
        .where(DocumentChunk.org_id == org_id, DocumentChunk.kb_id.in_(kb_ids))
    )
    rows = (await db.execute(base.where(DocumentChunk.tsv.op("@@")(tsq)).order_by(rank.desc()).limit(k))).all()
    hits = {(r.document_id, r.idx): Hit(r.document_id, r.filename, r.idx, r.content, float(r.score)) for r in rows}

    # Vector leg for knowledge bases with embeddings configured.
    kbs = (await db.scalars(select(KnowledgeBase).where(KnowledgeBase.id.in_(kb_ids),
                                                        KnowledgeBase.embedding_provider_id.is_not(None)))).all()
    for kb in kbs:
        prov = await db.get(LLMProvider, kb.embedding_provider_id)
        if not prov or not prov.embedding_model:
            continue
        try:
            [qv] = await provider_from_row(prov).embed([query[:2000]], prov.embedding_model)
        except Exception:  # noqa: S112 - degrade gracefully to keyword search
            continue
        dist = DocumentChunk.embedding.cosine_distance(qv).label("dist")
        vq = (
            select(DocumentChunk.document_id, Document.filename, DocumentChunk.idx, DocumentChunk.content, dist)
            .join(Document, Document.id == DocumentChunk.document_id)
            .where(DocumentChunk.org_id == org_id, DocumentChunk.kb_id == kb.id,
                   DocumentChunk.embedding.is_not(None),
                   func.vector_dims(DocumentChunk.embedding) == len(qv))
            .order_by(literal_column("dist")).limit(k)
        )
        for r in (await db.execute(vq)).all():
            key = (r.document_id, r.idx)
            score = 1.0 - float(r.dist)
            if key not in hits or hits[key].score < score:
                hits[key] = Hit(r.document_id, r.filename, r.idx, r.content, score)
    return sorted(hits.values(), key=lambda h: h.score, reverse=True)[:k]
