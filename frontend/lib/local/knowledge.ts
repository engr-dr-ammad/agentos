/** Browser edition knowledge base: parsing, chunking and permission-scoped retrieval. */
import { BASE_PATH } from "@/lib/env";
import { type Row, type State } from "./db";
import { buildProvider } from "./llm";

export const SUPPORTED = [".pdf", ".docx", ".txt", ".md", ".csv", ".json", ".html"];

export async function extractText(file: File): Promise<string> {
  const ext = file.name.includes(".") ? `.${file.name.split(".").pop()!.toLowerCase()}` : "";
  if (!SUPPORTED.includes(ext)) throw new Error(`Unsupported file type '${ext || file.name}'. Supported: ${SUPPORTED.join(", ")}`);
  if (ext === ".pdf") {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = `${BASE_PATH}/pdf.worker.min.mjs`;
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const pages: string[] = [];
    for (let i = 1; i <= Math.min(doc.numPages, 2000); i++) {
      const c = await (await doc.getPage(i)).getTextContent();
      pages.push(c.items.map((it) => ("str" in it ? it.str : "")).join(" "));
    }
    return pages.join("\n\n");
  }
  if (ext === ".docx") {
    const mammoth = await import("mammoth");
    return (await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value;
  }
  let text = await file.text();
  if (ext === ".csv") {
    const rows = text.split(/\r?\n/).filter(Boolean).map((l) => l.split(","));
    const [head, ...body] = rows;
    text = body.map((r) => head.map((h, i) => `${h.trim()}: ${(r[i] ?? "").trim()}`).join("; ")).join("\n");
  }
  if (ext === ".html") text = text.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ");
  return text;
}

export function chunkText(text: string, size = 1200, overlap = 150): string[] {
  const paras = text.replace(/[ \t]+/g, " ").trim().split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (let p of paras) {
    while (p.length > size) { if (cur) { out.push(cur); cur = ""; } out.push(p.slice(0, size)); p = p.slice(size - overlap); }
    if (cur.length + p.length + 2 <= size) cur = cur ? `${cur}\n\n${p}` : p;
    else { if (cur) out.push(cur); const tail = cur.slice(-overlap); cur = tail ? `${tail}\n\n${p}` : p; }
  }
  if (cur) out.push(cur);
  return out;
}

const tokens = (s: string): string[] => s.toLowerCase().match(/\p{L}[\p{L}\p{N}]{2,}|\p{N}{3,}/gu) ?? [];
const cosine = (a: number[], b: number[]) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] ** 2; y += b[i] ** 2; } return d / (Math.sqrt(x * y) || 1); };

export type Hit = { document_id: string; filename: string; chunk_idx: number; content: string; score: number };

/** Hybrid retrieval: BM25 over the allowed knowledge bases (+ cosine similarity where embeddings exist). */
export async function retrieve(s: State, org: string, kbIds: string[], query: string, k = 5): Promise<Hit[]> {
  const allowed = new Set(kbIds);
  const chunks = s.t.chunks.filter((c) => c.org_id === org && allowed.has(c.kb_id as string));
  if (!chunks.length || !query.trim()) return [];
  const q = [...new Set(tokens(query))].slice(0, 40);
  const docs = new Map(s.t.documents.map((d) => [d.id, d]));
  const N = chunks.length;
  const toks = chunks.map((c) => tokens(c.content as string));
  const avg = toks.reduce((a, t) => a + t.length, 0) / N;
  const df = new Map(q.map((w) => [w, toks.filter((t) => t.includes(w)).length]));
  const hits = new Map<string, Hit>();
  chunks.forEach((c, i) => {
    const t = toks[i];
    let score = 0;
    for (const w of q) {
      const f = t.filter((x) => x === w).length;
      if (!f) continue;
      const idf = Math.log(1 + (N - df.get(w)! + 0.5) / (df.get(w)! + 0.5));
      score += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * t.length / (avg || 1)));
    }
    if (score > 0) hits.set(c.id, { document_id: c.document_id as string, filename: (docs.get(c.document_id as string)?.filename as string) ?? "document", chunk_idx: c.idx as number, content: c.content as string, score });
  });
  for (const kb of s.t.kbs.filter((b) => allowed.has(b.id) && b.embedding_provider_id)) {
    const p = s.t.providers.find((x) => x.id === kb.embedding_provider_id);
    if (!p?.embedding_model) continue;
    try {
      const [qv] = await buildProvider(providerCfg(p)).embed([query.slice(0, 2000)], p.embedding_model as string);
      for (const c of chunks.filter((x) => x.kb_id === kb.id && Array.isArray(x.embedding) && (x.embedding as number[]).length === qv.length)) {
        const sc = cosine(qv, c.embedding as number[]);
        const cur = hits.get(c.id);
        if (!cur || cur.score < sc) hits.set(c.id, { document_id: c.document_id as string, filename: (docs.get(c.document_id as string)?.filename as string) ?? "document", chunk_idx: c.idx as number, content: c.content as string, score: sc });
      }
    } catch { /* fall back to keyword search */ }
  }
  return [...hits.values()].sort((a, b) => b.score - a.score).slice(0, k);
}

export const providerCfg = (p: Row) => ({ kind: p.kind as string, base_url: (p.base_url as string) ?? null, api_key: (p.api_key as string) ?? null, options: (p.options as Record<string, unknown>) ?? {} });
