from typing import Literal
from uuid import UUID

from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from ..config import get_settings
from ..deps import Manager, Viewer, get_or_404
from ..knowledge.service import SUPPORTED, UnsupportedDocument, extract_text, index_document, retrieve
from ..llm.base import LLMError
from ..models import Document, DocumentChunk, KnowledgeBase, LLMProvider, Organization
from ..plans import limit as plan_limit
from ..security import sha256

router = APIRouter(prefix="/knowledge", tags=["knowledge"])
settings = get_settings()


class KBIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    description: str = ""
    sensitivity: Literal["public", "internal", "confidential"] = "internal"
    embedding_provider_id: UUID | None = None


class KBPatch(BaseModel):
    name: str | None = None
    description: str | None = None
    sensitivity: Literal["public", "internal", "confidential"] | None = None
    embedding_provider_id: UUID | None = None


@router.get("/bases")
async def list_kbs(ctx: Viewer):
    counts = dict((await ctx.db.execute(select(Document.kb_id, func.count()).where(
        Document.org_id == ctx.org_id).group_by(Document.kb_id))).all())
    rows = (await ctx.db.scalars(select(KnowledgeBase).where(KnowledgeBase.org_id == ctx.org_id)
                                 .order_by(KnowledgeBase.name))).all()
    return [{"id": k.id, "name": k.name, "description": k.description, "sensitivity": k.sensitivity,
             "embedding_provider_id": k.embedding_provider_id, "documents": counts.get(k.id, 0),
             "created_at": k.created_at} for k in rows]


async def _check_embedder(ctx, pid: UUID | None):
    if pid:
        p = await get_or_404(ctx.db, LLMProvider, pid, ctx.org_id, "Model connection")
        if not p.embedding_model:
            raise HTTPException(422, f"'{p.name}' has no embedding model configured")


@router.post("/bases", status_code=201)
async def create_kb(body: KBIn, ctx: Manager):
    if await ctx.db.scalar(select(KnowledgeBase.id).where(KnowledgeBase.org_id == ctx.org_id,
                                                          KnowledgeBase.name == body.name)):
        raise HTTPException(409, "A knowledge base with this name exists")
    await _check_embedder(ctx, body.embedding_provider_id)
    kb = KnowledgeBase(org_id=ctx.org_id, **body.model_dump())
    ctx.db.add(kb)
    await ctx.db.flush()
    await ctx.audit("knowledge.base_created", "knowledge_base", kb.id, name=kb.name)
    await ctx.db.commit()
    return {"id": kb.id, "name": kb.name}


@router.patch("/bases/{kid}")
async def update_kb(kid: UUID, body: KBPatch, ctx: Manager):
    kb = await get_or_404(ctx.db, KnowledgeBase, kid, ctx.org_id, "Knowledge base")
    data = body.model_dump(exclude_unset=True)
    if "embedding_provider_id" in data:
        await _check_embedder(ctx, data["embedding_provider_id"])
    for k, v in data.items():
        setattr(kb, k, v)
    await ctx.db.commit()
    return {"ok": True, "reindex_required": "embedding_provider_id" in data}


@router.delete("/bases/{kid}")
async def delete_kb(kid: UUID, ctx: Manager):
    kb = await get_or_404(ctx.db, KnowledgeBase, kid, ctx.org_id, "Knowledge base")
    await ctx.db.delete(kb)  # documents and chunks cascade
    await ctx.audit("knowledge.base_deleted", "knowledge_base", kid, name=kb.name)
    await ctx.db.commit()
    return {"ok": True}


@router.get("/bases/{kid}/documents")
async def list_docs(kid: UUID, ctx: Viewer):
    await get_or_404(ctx.db, KnowledgeBase, kid, ctx.org_id, "Knowledge base")
    rows = (await ctx.db.scalars(select(Document).where(Document.kb_id == kid)
                                 .order_by(Document.created_at.desc()))).all()
    return [{"id": d.id, "filename": d.filename, "mime": d.mime, "size_bytes": d.size_bytes, "version": d.version,
             "status": d.status, "chunk_count": d.chunk_count, "error": d.error, "created_at": d.created_at}
            for d in rows]


@router.post("/bases/{kid}/documents", status_code=201)
async def upload(kid: UUID, ctx: Manager, file: UploadFile = File(...)):
    kb = await get_or_404(ctx.db, KnowledgeBase, kid, ctx.org_id, "Knowledge base")
    org = await ctx.db.get(Organization, ctx.org_id)
    cap = plan_limit(org.plan, "documents")
    n = await ctx.db.scalar(select(func.count()).select_from(Document).where(Document.org_id == ctx.org_id))
    if cap is not None and n >= cap:
        raise HTTPException(402, f"Your plan allows {cap} documents")
    max_bytes = settings.max_upload_mb * 1024 * 1024
    data = await file.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise HTTPException(413, f"Files are limited to {settings.max_upload_mb} MB")
    name = (file.filename or "upload.txt").replace("/", "_").replace("\\", "_")[:300]
    try:
        text = extract_text(name, data)
    except UnsupportedDocument as e:
        raise HTTPException(415, str(e)) from e
    except Exception as e:
        raise HTTPException(422, f"Could not read this file: {e.__class__.__name__}") from e
    if not text.strip():
        raise HTTPException(422, "No text could be extracted (scanned PDFs need OCR first)")
    prev = await ctx.db.scalar(select(Document).where(Document.kb_id == kid, Document.filename == name))
    digest = sha256(data)
    if prev and prev.sha256 == digest:
        return {"id": prev.id, "version": prev.version, "unchanged": True, "chunk_count": prev.chunk_count}
    doc = prev or Document(org_id=ctx.org_id, kb_id=kid, filename=name, version=0, size_bytes=0, sha256="",
                           mime="")
    doc.version += 1
    doc.size_bytes, doc.sha256, doc.uploaded_by = len(data), digest, ctx.user.id
    doc.mime = SUPPORTED.get("." + name.rsplit(".", 1)[-1].lower(), "application/octet-stream")
    if prev is None:
        ctx.db.add(doc)
    await ctx.db.flush()
    try:
        doc.chunk_count = await index_document(ctx.db, org_id=ctx.org_id, kb=kb, document_id=doc.id, text=text)
        doc.status, doc.error = "indexed", None
    except LLMError as e:
        doc.status, doc.error = "error", f"Embedding failed: {e}"[:500]
        doc.chunk_count = await index_document(ctx.db, org_id=ctx.org_id,
                                               kb=KnowledgeBase(id=kb.id, embedding_provider_id=None),
                                               document_id=doc.id, text=text)
    await ctx.audit("knowledge.document_uploaded", "document", doc.id, filename=name, version=doc.version)
    await ctx.db.commit()
    return {"id": doc.id, "version": doc.version, "chunk_count": doc.chunk_count, "status": doc.status,
            "error": doc.error}


@router.delete("/documents/{did}")
async def delete_doc(did: UUID, ctx: Manager):
    d = await get_or_404(ctx.db, Document, did, ctx.org_id, "Document")
    await ctx.db.delete(d)  # chunks and embeddings cascade → no longer retrievable
    await ctx.audit("knowledge.document_deleted", "document", did, filename=d.filename)
    await ctx.db.commit()
    return {"ok": True}


@router.get("/documents/{did}/chunks")
async def doc_chunks(did: UUID, ctx: Viewer):
    await get_or_404(ctx.db, Document, did, ctx.org_id, "Document")
    rows = (await ctx.db.scalars(select(DocumentChunk).where(DocumentChunk.document_id == did)
                                 .order_by(DocumentChunk.idx).limit(200))).all()
    return [{"idx": c.idx, "content": c.content, "embedded": c.embedding is not None} for c in rows]


class SearchIn(BaseModel):
    query: str = Field(min_length=1, max_length=2000)
    kb_ids: list[UUID]
    k: int = Field(5, ge=1, le=20)


@router.post("/search")
async def search(body: SearchIn, ctx: Viewer):
    hits = await retrieve(ctx.db, org_id=ctx.org_id, kb_ids=body.kb_ids, query=body.query, k=body.k)
    return [{"document": h.filename, "document_id": h.document_id, "chunk": h.chunk_idx, "content": h.content,
             "score": round(h.score, 4)} for h in hits]
