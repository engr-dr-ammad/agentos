"use client";

import { BookOpen, FileText, Plus, Search, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Alert, Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, Loading, PageHeader, Select, StatusBadge, Textarea } from "@/components/ui";
import { ApiError, del, post } from "@/lib/api";
import { useAction, useList, useMe } from "@/lib/hooks";
import type { KB, Provider } from "@/lib/types";
import { ago, can } from "@/lib/utils";

type Doc = { id: string; filename: string; size_bytes: number; version: number; status: string; chunk_count: number; error: string | null; created_at: string };
type Hit = { document: string; chunk: number; content: string; score: number };

export default function Knowledge() {
  const me = useMe();
  const kbs = useList<KB[]>(["kbs"], "/knowledge/bases");
  const providers = useList<Provider[]>(["providers"], "/providers");
  const [active, setActive] = useState<string | null>(null);
  const kb = kbs.data?.find((k) => k.id === (active ?? kbs.data?.[0]?.id));
  const docs = useList<Doc[]>(["docs", kb?.id], `/knowledge/bases/${kb?.id}/documents`, { enabled: !!kb });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", sensitivity: "internal", embedding_provider_id: "" });
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const manager = can(me.data?.org?.role, "manager");
  const create = useAction(() => post<{ id: string }>("/knowledge/bases", { ...form, embedding_provider_id: form.embedding_provider_id || null }), {
    success: "Knowledge base created", invalidate: [["kbs"]], onSuccess: (r) => { setActive(r.id); setOpen(false); } });
  const remove = useAction((id: string) => del(`/knowledge/documents/${id}`), { success: "Document deleted and removed from search", invalidate: [["docs", kb?.id], ["kbs"]] });
  const removeKb = useAction((id: string) => del(`/knowledge/bases/${id}`), { success: "Knowledge base deleted", invalidate: [["kbs"]], onSuccess: () => setActive(null) });
  const search = useAction(() => post<Hit[]>("/knowledge/search", { query: q, kb_ids: [kb!.id], k: 5 }), { onSuccess: setHits });

  const upload = async (files: FileList) => {
    if (!kb) return;
    setUploading(true);
    for (const f of Array.from(files)) {
      const fd = new FormData(); fd.append("file", f);
      try {
        const res = await fetch(`/api/v1/knowledge/bases/${kb.id}/documents`, { method: "POST", body: fd, headers: { "x-agentos-csrf": "1" } });
        const data = await res.json();
        if (!res.ok) throw new ApiError(res.status, data.detail ?? "Upload failed");
        toast.success(data.unchanged ? `${f.name} unchanged` : `${f.name} indexed (${data.chunk_count} passages)`);
      } catch (e) { toast.error(`${f.name}: ${(e as Error).message}`); }
    }
    setUploading(false); docs.refetch(); kbs.refetch();
  };

  return (
    <>
      <PageHeader title="Knowledge Base" description="Documents your agents may use. Each agent only sees the knowledge bases you link to it, enforced during retrieval."
        actions={manager && <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" aria-hidden />New knowledge base</Button>} />
      {kbs.isLoading ? <Loading /> : !kbs.data?.length ? (
        <EmptyState icon={<BookOpen className="h-8 w-8" />} title="No knowledge bases yet" description="Create one for each kind of information — for example “Product catalogue” or “HR policies” — so access can be granted separately."
          action={manager && <Button onClick={() => setOpen(true)}>Create knowledge base</Button>} />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[16rem_1fr]">
          <nav className="space-y-1" aria-label="Knowledge bases">{kbs.data.map((k) => (
            <button key={k.id} onClick={() => { setActive(k.id); setHits(null); }} className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm ${kb?.id === k.id ? "bg-accent-soft font-medium text-accent" : "hover:bg-surface-2"}`}>
              <span className="truncate">{k.name}</span><span className="text-xs text-text-3">{k.documents}</span></button>))}</nav>
          {kb && <div className="space-y-6">
            <Card>
              <CardHeader title={kb.name} description={<span className="flex items-center gap-2">{kb.description}<Badge>{kb.sensitivity}</Badge>{kb.embedding_provider_id ? <Badge tone="accent">semantic + keyword search</Badge> : <Badge>keyword search</Badge>}</span>}
                action={manager && <div className="flex gap-2">
                  <input ref={file} type="file" multiple className="hidden" accept=".pdf,.docx,.txt,.md,.csv,.json,.html" onChange={(e) => e.target.files && upload(e.target.files)} />
                  <Button size="sm" onClick={() => file.current?.click()} loading={uploading}><Upload className="h-4 w-4" aria-hidden />Upload</Button>
                  <Button size="sm" variant="ghost" aria-label="Delete knowledge base" onClick={() => confirm(`Delete ${kb.name} and all its documents?`) && removeKb.mutate(kb.id)}><Trash2 className="h-4 w-4" /></Button></div>} />
              {docs.isLoading ? <div className="p-5"><Loading rows={2} /></div> : !docs.data?.length ? <p className="p-5 text-sm text-text-2">Upload PDF, Word, text, Markdown, CSV, JSON or HTML files (max 20 MB each). Scanned PDFs need OCR first.</p> : (
                <ul className="divide-y divide-border">{docs.data.map((d) => (
                  <li key={d.id} className="flex items-center gap-3 px-5 py-3 text-sm"><FileText className="h-4 w-4 text-text-3" aria-hidden />
                    <span className="min-w-0 flex-1"><span className="block truncate font-medium">{d.filename}</span><span className="text-xs text-text-3">v{d.version} · {d.chunk_count} passages · {(d.size_bytes / 1024).toFixed(0)} KB · {ago(d.created_at)}</span>{d.error && <span className="block text-xs text-warning">{d.error}</span>}</span>
                    <StatusBadge status={d.status === "indexed" ? "completed" : d.status} />
                    {manager && <Button size="icon" variant="ghost" aria-label={`Delete ${d.filename}`} onClick={() => remove.mutate(d.id)}><Trash2 className="h-4 w-4" /></Button>}</li>))}</ul>)}
            </Card>
            <Card><CardHeader title="Test retrieval" description="See which passages an agent linked to this knowledge base would receive." />
              <form className="flex gap-2 p-5" onSubmit={(e) => { e.preventDefault(); if (q.trim()) search.mutate(undefined); }}>
                <Input aria-label="Search query" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. price of standing desk" /><Button loading={search.isPending}><Search className="h-4 w-4" aria-hidden />Search</Button></form>
              {hits && <div className="space-y-2 px-5 pb-5">{!hits.length ? <p className="text-sm text-text-2">No matching passages.</p> : hits.map((h, i) => (
                <div key={i} className="rounded-lg border border-border p-3 text-sm"><p className="mb-1 text-xs text-text-3">{h.document} · passage {h.chunk} · score {h.score}</p><p className="line-clamp-4 whitespace-pre-wrap text-text-2">{h.content}</p></div>))}</div>}
            </Card>
            <Alert>Document text is passed to agents as untrusted data. Instructions hidden inside a document cannot override your agent&apos;s rules or trigger actions.</Alert>
          </div>}
        </div>
      )}
      <Dialog open={open} onOpenChange={setOpen} title="New knowledge base" footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button disabled={!form.name} loading={create.isPending} onClick={() => create.mutate(undefined)}>Create</Button></>}>
        <div className="space-y-4">
          <Field label="Name">{(id) => <Input id={id} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Product catalogue" />}</Field>
          <Field label="Description">{(id) => <Textarea id={id} rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />}</Field>
          <Field label="Sensitivity">{(id) => <Select id={id} value={form.sensitivity} onChange={(e) => setForm({ ...form, sensitivity: e.target.value })}><option value="public">Public</option><option value="internal">Internal</option><option value="confidential">Confidential</option></Select>}</Field>
          <Field label="Semantic search (optional)" help="Uses the embedding model of the selected connection. Keyword search always works.">{(id) => (
            <Select id={id} value={form.embedding_provider_id} onChange={(e) => setForm({ ...form, embedding_provider_id: e.target.value })}><option value="">Keyword search only</option>
              {providers.data?.filter((p) => p.embedding_model).map((p) => <option key={p.id} value={p.id}>{p.name} · {p.embedding_model}</option>)}</Select>)}</Field>
        </div>
      </Dialog>
    </>
  );
}
