"use client";

import { Bot, CheckCircle2, KeyRound, Mail, Plug, Plus, Star, Trash2, XCircle } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Alert, Badge, Button, Card, CardHeader, Dialog, Field, Input, Loading, PageHeader, Select, StatusBadge, Switch, Tabs } from "@/components/ui";
import { del, patch, post } from "@/lib/api";
import { useAction, useList, useMe } from "@/lib/hooks";
import type { Connection, Provider, Workflow } from "@/lib/types";
import { ago, can } from "@/lib/utils";

type Preset = { id: string; label: string; kind: string; base_url: string; model_hint: string; embedding_hint?: string; options?: Record<string, unknown>; no_key?: boolean };
type ConnTypes = { available: Record<string, { label: string; secret: string | null; fields: string[]; description: string }>; planned: string[] };
type OutboxMsg = { id: string; to: string; subject: string; body: string; created_at: string };

function ProviderDialog({ onClose, presets, editing }: { onClose: () => void; presets: Preset[]; editing?: Provider }) {
  const [preset, setPreset] = useState<Preset | undefined>(editing ? undefined : presets[0]);
  const [f, setF] = useState(() => editing
    ? { name: editing.name, base_url: editing.base_url ?? "", api_key: "", default_model: editing.default_model, embedding_model: editing.embedding_model ?? "", price_in: String(editing.price_in_per_mtok), price_out: String(editing.price_out_per_mtok), is_default: editing.is_default, privacy_tier: editing.privacy_tier }
    : { name: presets[0]?.label ?? "", base_url: presets[0]?.base_url ?? "", api_key: "", default_model: "", embedding_model: "", price_in: "0", price_out: "0", is_default: true, privacy_tier: "external" });
  const pick = (id: string) => { const p = presets.find((x) => x.id === id)!; setPreset(p); setF({ ...f, name: p.label, base_url: p.base_url, privacy_tier: p.no_key ? "self_hosted" : "external" }); };
  const save = useAction(async () => {
    const body = { name: f.name, base_url: f.base_url || null, default_model: f.default_model, embedding_model: f.embedding_model || null,
      price_in_per_mtok: Number(f.price_in || 0), price_out_per_mtok: Number(f.price_out || 0), is_default: f.is_default, privacy_tier: f.privacy_tier,
      ...(f.api_key ? { api_key: f.api_key } : {}) };
    const p = editing ? await patch<Provider>(`/providers/${editing.id}`, body)
      : await post<Provider>("/providers", { ...body, kind: preset!.kind, options: preset!.options ?? {} });
    const t = await post<{ ok: boolean; detail: string }>(`/providers/${p.id}/test`);
    t.ok ? toast.success(`Connected: model replied “${t.detail}”`) : toast.warning(`Saved, but the test failed: ${t.detail}`);
  }, { invalidate: [["providers"]], onSuccess: onClose });
  const k = (key: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [key]: e.target.value });
  return (
    <Dialog open onOpenChange={onClose} title={editing ? `Edit ${editing.name}` : "Connect an AI model"} wide
      description="Your API key is encrypted on the server and is never shown again, sent to the browser or included in prompts."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={save.isPending} disabled={!f.name || !f.default_model} onClick={() => save.mutate(undefined)}>Save and test</Button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        {!editing && <Field label="Provider" className="sm:col-span-2">{(id) => <Select id={id} value={preset?.id} onChange={(e) => pick(e.target.value)}>{presets.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</Select>}</Field>}
        <Field label="Display name">{(id) => <Input id={id} value={f.name} onChange={k("name")} />}</Field>
        <Field label="Base URL">{(id) => <Input id={id} value={f.base_url} onChange={k("base_url")} />}</Field>
        <Field label={editing?.has_key ? `API key (stored ${editing.api_key_hint}; leave empty to keep)` : "API key"} help={preset?.no_key ? "Not required for most self-hosted servers" : undefined}>
          {(id) => <Input id={id} type="password" autoComplete="off" value={f.api_key} onChange={k("api_key")} />}</Field>
        <Field label="Default model" help={preset?.model_hint}>{(id) => <Input id={id} value={f.default_model} onChange={k("default_model")} />}</Field>
        <Field label="Embedding model (optional)" help={preset?.embedding_hint ? `e.g. ${preset.embedding_hint} — enables semantic search` : "Enables semantic knowledge search"}>{(id) => <Input id={id} value={f.embedding_model} onChange={k("embedding_model")} />}</Field>
        <Field label="Data handling">{(id) => <Select id={id} value={f.privacy_tier} onChange={k("privacy_tier")}><option value="external">External provider</option><option value="eu_only">EU-hosted provider</option><option value="self_hosted">Self-hosted</option></Select>}</Field>
        <Field label="Input price (USD per 1M tokens)" help="From your provider's price list — used for cost tracking and budgets">{(id) => <Input id={id} type="number" min={0} step="0.01" value={f.price_in} onChange={k("price_in")} />}</Field>
        <Field label="Output price (USD per 1M tokens)">{(id) => <Input id={id} type="number" min={0} step="0.01" value={f.price_out} onChange={k("price_out")} />}</Field>
        <label className="flex items-center gap-3 text-sm sm:col-span-2"><Switch checked={f.is_default} onChange={(v) => setF({ ...f, is_default: v })} label="Organisation default" />Use as the organisation default for agents without a specific model</label>
      </div>
    </Dialog>
  );
}

function ConnectionDialog({ types, onClose, workflows }: { types: ConnTypes; onClose: () => void; workflows: Workflow[] }) {
  const [kind, setKind] = useState("smtp");
  const [name, setName] = useState("");
  const [cfg, setCfg] = useState<Record<string, string | boolean>>({ port: "587", starttls: true });
  const [secret, setSecret] = useState("");
  const [restrict, setRestrict] = useState(false);
  const [allowed, setAllowed] = useState<string[]>([]);
  const spec = types.available[kind];
  const save = useAction(async () => {
    const config = Object.fromEntries(spec.fields.map((f) => [f, f === "port" ? Number(cfg[f] || 0) : f === "starttls" ? !!cfg[f] : cfg[f] ?? ""]).filter(([, v]) => v !== ""));
    const c = await post<Connection>("/connections", { kind, name: name || spec.label, config, secret: secret || null, allowed_workflow_ids: restrict ? allowed : null });
    const t = await post<{ ok: boolean; detail: string }>(`/connections/${c.id}/test`);
    t.ok ? toast.success(t.detail) : toast.warning(`Saved, but the test failed: ${t.detail}`);
  }, { invalidate: [["connections"]], onSuccess: onClose });
  return (
    <Dialog open onOpenChange={onClose} title="Connect an app" wide footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate(undefined)}>Save and test</Button></>}>
      <ol className="mb-4 flex flex-wrap gap-2 text-xs text-text-3">{["Select application", "Connect account", "Review permissions", "Choose who may use it", "Test", "Save"].map((s, i) => <li key={s} className="rounded-full border border-border px-2 py-0.5">{i + 1}. {s}</li>)}</ol>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Application">{(id) => <Select id={id} value={kind} onChange={(e) => setKind(e.target.value)}>{Object.entries(types.available).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</Select>}</Field>
        <Field label="Name">{(id) => <Input id={id} value={name} placeholder={spec.label} onChange={(e) => setName(e.target.value)} />}</Field>
        <p className="text-sm text-text-2 sm:col-span-2">{spec.description}</p>
        {spec.fields.map((fld) => fld === "starttls" ? (
          <label key={fld} className="flex items-center gap-3 text-sm"><Switch checked={!!cfg.starttls} onChange={(v) => setCfg({ ...cfg, starttls: v })} label="STARTTLS" />Use STARTTLS</label>
        ) : <Field key={fld} label={fld.replace(/_/g, " ")}>{(id) => <Input id={id} value={String(cfg[fld] ?? "")} onChange={(e) => setCfg({ ...cfg, [fld]: e.target.value })} placeholder={fld === "auth_header" ? "Authorization" : fld === "base_url" ? "https://api.example.com" : undefined} />}</Field>)}
        {spec.secret && <Field label={spec.secret} help="Encrypted at rest; never shown again">{(id) => <Input id={id} type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />}</Field>}
        <div className="space-y-2 sm:col-span-2">
          <label className="flex items-center gap-3 text-sm"><Switch checked={restrict} onChange={setRestrict} label="Restrict workflows" />Only allow specific workflows to use this connection</label>
          {restrict && <div className="grid gap-1 sm:grid-cols-2">{workflows.map((w) => <label key={w.id} className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-[var(--accent)]" checked={allowed.includes(w.id)} onChange={(e) => setAllowed(e.target.checked ? [...allowed, w.id] : allowed.filter((x) => x !== w.id))} />{w.name}</label>)}</div>}
        </div>
        <div className="sm:col-span-2"><Alert>Every action through this connection passes the tool gateway: tenant and workflow permission, linked approval, rate limit ({`30/min default`}) and duplicate protection.</Alert></div>
      </div>
    </Dialog>
  );
}

export default function Integrations() {
  const me = useMe();
  const [tab, setTab] = useState<"models" | "apps" | "outbox">("models");
  const providers = useList<Provider[]>(["providers"], "/providers");
  const presets = useList<Preset[]>(["presets"], "/providers/presets");
  const conns = useList<Connection[]>(["connections"], "/connections");
  const types = useList<ConnTypes>(["conn-types"], "/connections/types");
  const workflows = useList<Workflow[]>(["workflows"], "/workflows");
  const outbox = useList<OutboxMsg[]>(["outbox"], "/outbox", { enabled: tab === "outbox" });
  const [pd, setPd] = useState<null | "new" | Provider>(null);
  const [cd, setCd] = useState(false);
  const admin = can(me.data?.org?.role, "admin");
  const testP = useAction((id: string) => post<{ ok: boolean; detail: string }>(`/providers/${id}/test`), { invalidate: [["providers"]], onSuccess: (r) => r.ok ? toast.success(`OK: ${r.detail}`) : toast.error(r.detail) });
  const delP = useAction((id: string) => del(`/providers/${id}`), { success: "Removed", invalidate: [["providers"]] });
  const defP = useAction((id: string) => patch(`/providers/${id}`, { is_default: true }), { success: "Default updated", invalidate: [["providers"]] });
  const testC = useAction((id: string) => post<{ ok: boolean; detail: string }>(`/connections/${id}/test`), { invalidate: [["connections"]], onSuccess: (r) => r.ok ? toast.success(r.detail) : toast.error(r.detail) });
  const revokeC = useAction((c: Connection) => patch(`/connections/${c.id}`, { status: c.status === "active" ? "revoked" : "active" }), { success: "Updated", invalidate: [["connections"]] });
  const delC = useAction((id: string) => del(`/connections/${id}`), { success: "Removed", invalidate: [["connections"]] });

  return (
    <>
      <PageHeader title="Integrations" description="Bring your own AI models and connect the business apps your agents may act through."
        actions={admin && (tab === "models" ? <Button onClick={() => setPd("new")}><Plus className="h-4 w-4" aria-hidden />Connect AI model</Button> : tab === "apps" ? <Button onClick={() => setCd(true)}><Plus className="h-4 w-4" aria-hidden />Connect app</Button> : null)} />
      <div className="mb-5"><Tabs value={tab} onChange={setTab} items={[{ value: "models", label: "AI models", count: providers.data?.length }, { value: "apps", label: "Apps", count: conns.data?.length }, { value: "outbox", label: "Sandbox outbox" }]} /></div>
      {!admin && <div className="mb-4"><Alert>Only admins can add or change integrations.</Alert></div>}
      {tab === "models" && (providers.isLoading ? <Loading /> : (
        <div className="grid gap-4 md:grid-cols-2">{providers.data?.map((p) => (
          <Card key={p.id} className="p-5">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-lg bg-accent-soft text-accent"><Bot className="h-4 w-4" aria-hidden /></span>
                <div><h3 className="flex items-center gap-1.5 font-medium">{p.name}{p.is_default && <Badge tone="accent"><Star className="h-3 w-3" aria-hidden />default</Badge>}</h3>
                  <p className="text-xs text-text-3">{p.kind.replace("_", " ")} · {p.default_model}{p.embedding_model ? ` · embeddings: ${p.embedding_model}` : ""}</p></div></div>
              {p.last_test_ok == null ? null : p.last_test_ok ? <CheckCircle2 className="h-4 w-4 text-good" aria-label="Last test passed" /> : <XCircle className="h-4 w-4 text-critical" aria-label="Last test failed" />}
            </div>
            <dl className="mt-3 grid grid-cols-3 gap-2 text-xs"><div><dt className="text-text-3">Key</dt><dd className="flex items-center gap-1"><KeyRound className="h-3 w-3" aria-hidden />{p.has_key ? p.api_key_hint : "none"}</dd></div>
              <div><dt className="text-text-3">Price in/out per 1M</dt><dd>${Number(p.price_in_per_mtok)} / ${Number(p.price_out_per_mtok)}</dd></div><div><dt className="text-text-3">Data</dt><dd>{p.privacy_tier.replace("_", " ")}</dd></div></dl>
            {p.kind === "sandbox" && <p className="mt-3 text-xs text-warning">Offline demo model — produces clearly labelled simulated output.</p>}
            {admin && <div className="mt-4 flex flex-wrap gap-2"><Button size="sm" variant="secondary" onClick={() => testP.mutate(p.id)} loading={testP.isPending && testP.variables === p.id}>Test</Button>
              {p.kind !== "sandbox" && <Button size="sm" variant="ghost" onClick={() => setPd(p)}>Edit / rotate key</Button>}
              {!p.is_default && <Button size="sm" variant="ghost" onClick={() => defP.mutate(p.id)}>Make default</Button>}
              <Button size="sm" variant="ghost" aria-label={`Remove ${p.name}`} onClick={() => confirm(`Remove ${p.name}?`) && delP.mutate(p.id)}><Trash2 className="h-4 w-4" /></Button></div>}
          </Card>))}
          <Card className="p-5 text-sm text-text-2 md:col-span-2"><p className="font-medium text-text">Not tied to any single model vendor</p>
            <p className="mt-1">AgentOS supports any OpenAI-compatible API (OpenAI, Azure OpenAI, Mistral, Groq, DeepSeek, OpenRouter, Together, xAI, Fireworks, Ollama, vLLM, LM Studio), Anthropic and Google Gemini. Each agent can use a different model; switching is a dropdown change.</p></Card>
        </div>))}
      {tab === "apps" && (conns.isLoading ? <Loading /> : <>
        <div className="grid gap-4 md:grid-cols-2">{conns.data?.map((c) => (
          <Card key={c.id} className="p-5">
            <div className="flex items-start justify-between"><div className="flex items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-lg bg-surface-2 text-text-2">{c.kind.includes("email") || c.kind === "smtp" ? <Mail className="h-4 w-4" aria-hidden /> : <Plug className="h-4 w-4" aria-hidden />}</span>
              <div><h3 className="font-medium">{c.name}</h3><p className="text-xs text-text-3">{c.label}{c.kind.startsWith("sandbox") ? " · sandbox" : ""}</p></div></div><StatusBadge status={c.status} /></div>
            <p className="mt-3 text-xs text-text-2">{c.allowed_workflow_ids ? `Restricted to ${c.allowed_workflow_ids.length} workflow(s)` : "Any workflow may request actions"} · {c.rate_limit_per_minute}/min</p>
            {admin && <div className="mt-4 flex gap-2"><Button size="sm" variant="secondary" onClick={() => testC.mutate(c.id)}>Test</Button>
              <Button size="sm" variant="ghost" onClick={() => revokeC.mutate(c)}>{c.status === "active" ? "Revoke" : "Re-enable"}</Button>
              <Button size="sm" variant="ghost" aria-label={`Remove ${c.name}`} onClick={() => confirm(`Remove ${c.name}?`) && delC.mutate(c.id)}><Trash2 className="h-4 w-4" /></Button></div>}
          </Card>))}</div>
        {types.data && <Card className="mt-6"><CardHeader title="Coming next" description="OAuth connectors on the roadmap. Until then, use SMTP (works with Gmail and Microsoft 365 app passwords), webhooks and REST API connections." />
          <div className="flex flex-wrap gap-2 p-5">{types.data.planned.map((p) => <Badge key={p}>{p}</Badge>)}</div></Card>}
      </>)}
      {tab === "outbox" && (outbox.isLoading ? <Loading /> : (
        <Card><CardHeader title="Sandbox outbox" description="Emails from test runs and sandbox connections. These were never delivered." />
          {!outbox.data?.length ? <p className="p-5 text-sm text-text-2">Empty.</p> : <ul className="divide-y divide-border">{outbox.data.map((m) => (
            <li key={m.id} className="px-5 py-3 text-sm"><details><summary className="cursor-pointer"><span className="font-medium">{m.subject}</span> <span className="text-text-3">→ {m.to} · {ago(m.created_at)}</span></summary>
              <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-surface-2 p-3 font-sans text-text-2">{m.body}</pre></details></li>))}</ul>}</Card>))}
      {pd && presets.data && <ProviderDialog presets={presets.data} editing={pd === "new" ? undefined : pd} onClose={() => setPd(null)} />}
      {cd && types.data && <ConnectionDialog types={types.data} workflows={workflows.data ?? []} onClose={() => setCd(false)} />}
    </>
  );
}
