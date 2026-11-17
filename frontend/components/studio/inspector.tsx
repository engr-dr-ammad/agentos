"use client";

import { AlertCircle, Copy, Info, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Alert, Badge, Button, Code, Field, Input, Select, StatusBadge, Textarea } from "@/components/ui";
import type { Agent, Connection, FieldSpec, Issue, KB, NodeRun, NodeSpec } from "@/lib/types";
import { money } from "@/lib/utils";

type Props = {
  nodeId: string; kind: string; label: string; config: Record<string, unknown>; spec: NodeSpec;
  agents: Agent[]; connections: Connection[]; kbs: KB[]; actionNodes: { id: string; label: string }[];
  upstream: { id: string; label: string; kind: string }[]; issues: Issue[]; run?: NodeRun; readOnly?: boolean;
  onChange: (patch: { label?: string; config?: Record<string, unknown> }) => void; onDelete: () => void; onDuplicate: () => void;
};

function JsonField({ id, value, onChange, disabled }: { id: string; value: unknown; onChange: (v: unknown) => void; disabled?: boolean }) {
  const [text, setText] = useState(() => JSON.stringify(value ?? {}, null, 2));
  const [err, setErr] = useState(false);
  useEffect(() => { setText(JSON.stringify(value ?? {}, null, 2)); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <Textarea id={id} rows={6} className="font-mono text-xs" value={text} disabled={disabled} aria-invalid={err}
        onChange={(e) => { setText(e.target.value); try { onChange(JSON.parse(e.target.value)); setErr(false); } catch { setErr(true); } }} />
      {err && <p className="text-xs text-critical">Not valid JSON yet — changes are kept when it parses.</p>}
    </>
  );
}

export function Inspector(p: Props) {
  const { spec, config } = p;
  const set = (k: string, v: unknown) => p.onChange({ config: { ...config, [k]: v } });
  const renderField = (f: FieldSpec, id: string) => {
    const v = config[f.key] ?? "";
    const dis = p.readOnly;
    switch (f.kind) {
      case "textarea": return <Textarea id={id} rows={4} value={String(v)} disabled={dis} onChange={(e) => set(f.key, e.target.value)} />;
      case "number": return <Input id={id} type="number" value={v === "" ? "" : Number(v)} disabled={dis} onChange={(e) => set(f.key, e.target.value === "" ? null : Number(e.target.value))} />;
      case "select": return <Select id={id} value={String(v || f.default || "")} disabled={dis} onChange={(e) => set(f.key, e.target.value)}>{f.options?.map(([val, l]) => <option key={val} value={val}>{l}</option>)}</Select>;
      case "json": return <JsonField id={`${p.nodeId}:${f.key}`} value={config[f.key] ?? f.default} disabled={dis} onChange={(nv) => set(f.key, nv)} />;
      case "agent": return (
        <Select id={id} value={String(v)} disabled={dis} onChange={(e) => p.onChange({ config: { ...config, agent_id: e.target.value }, label: p.agents.find((a) => a.id === e.target.value)?.name ?? p.label })}>
          <option value="">Choose an agent…</option>{p.agents.map((a) => <option key={a.id} value={a.id}>{a.name}{a.status !== "active" ? ` (${a.status})` : ""}</option>)}</Select>);
      case "connection": return (
        <Select id={id} value={String(v)} disabled={dis} onChange={(e) => set(f.key, e.target.value)}>
          <option value="">Choose a connection…</option>
          {p.connections.filter((c) => !spec.connection_kinds || spec.connection_kinds.includes(c.kind)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>);
      case "node": return (
        <Select id={id} value={String(v)} disabled={dis} onChange={(e) => set(f.key, e.target.value)}>
          <option value="">Choose the action…</option>{p.actionNodes.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}</Select>);
      case "kbs": {
        const sel = (Array.isArray(v) ? v : []) as string[];
        return <div className="space-y-1">{p.kbs.map((k) => <label key={k.id} className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={dis} className="accent-[var(--accent)]" checked={sel.includes(k.id)}
          onChange={(e) => set(f.key, e.target.checked ? [...sel, k.id] : sel.filter((x) => x !== k.id))} />{k.name}</label>)}{!p.kbs.length && <p className="text-xs text-text-3">No knowledge bases.</p>}</div>;
      }
      default: return <Input id={id} value={String(v)} disabled={dis} onChange={(e) => set(f.key, e.target.value)} />;
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs uppercase tracking-wide text-text-3">{spec.category}</p>
        <h2 className="font-semibold">{spec.label}</h2>
        <p className="mt-1 text-sm text-text-2">{spec.description}</p>
        {spec.sensitive && <Badge tone="warning" className="mt-2">Requires a linked approval</Badge>}
      </div>
      {p.issues.length > 0 && <div className="space-y-2">{p.issues.map((i, k) => <Alert key={k} tone={i.severity === "error" ? "critical" : "warning"}>{i.message}</Alert>)}</div>}
      {p.run && (
        <div className="space-y-2 rounded-lg border border-border p-3">
          <div className="flex flex-wrap items-center gap-2 text-xs"><StatusBadge status={p.run.status} />
            {p.run.duration_ms != null && <Badge>{(p.run.duration_ms / 1000).toFixed(2)}s</Badge>}
            {p.run.cost_usd > 0 && <Badge>{money(p.run.cost_usd)}</Badge>}
            {p.run.tokens_in + p.run.tokens_out > 0 && <Badge>{p.run.tokens_in}+{p.run.tokens_out} tok</Badge>}
            {p.run.attempt > 1 && <Badge tone="warning">attempt {p.run.attempt}</Badge>}</div>
          {p.run.error && <Alert tone="critical">{p.run.error}</Alert>}
          {p.run.output && <Code>{JSON.stringify(p.run.output, null, 2)}</Code>}
        </div>
      )}
      <Field label="Step name">{(id) => <Input id={id} value={p.label} disabled={p.readOnly} onChange={(e) => p.onChange({ label: e.target.value })} />}</Field>
      {spec.fields.map((f) => (
        <Field key={f.key} label={f.label + (f.required ? " *" : "")} help={f.help || (f.template ? "Supports {{ templates }}" : undefined)}>{(id) => renderField(f, id)}</Field>
      ))}
      {p.upstream.length > 0 && (
        <details className="rounded-lg border border-border p-3 text-sm">
          <summary className="flex cursor-pointer items-center gap-1.5 font-medium"><Info className="h-4 w-4 text-text-3" aria-hidden />Data you can use here</summary>
          <ul className="mt-2 space-y-1 font-mono text-xs text-text-2">
            {p.upstream.map((u) => {
              const ref = u.kind.startsWith("trigger.") ? "{{ trigger }}" : u.kind === "agent" ? `{{ nodes.${u.id}.result }}` : `{{ nodes.${u.id} }}`;
              return <li key={u.id} className="flex items-center justify-between gap-2"><span className="truncate">{u.label}: {ref}</span>
                <button type="button" className="rounded p-0.5 hover:bg-surface-2" aria-label={`Copy ${ref}`} onClick={() => navigator.clipboard?.writeText(ref)}><Copy className="h-3.5 w-3.5" /></button></li>;
            })}
          </ul>
          <p className="mt-2 text-xs text-text-3">Use dots for fields, e.g. <code>{"{{ nodes.sales.result.total }}"}</code></p>
        </details>
      )}
      {!p.readOnly && (
        <div className="flex gap-2 border-t border-border pt-4">
          <Button size="sm" variant="secondary" onClick={p.onDuplicate}><Copy className="h-3.5 w-3.5" aria-hidden />Duplicate</Button>
          <Button size="sm" variant="ghost" onClick={p.onDelete}><Trash2 className="h-3.5 w-3.5" aria-hidden />Delete</Button>
        </div>
      )}
      <p className="flex items-center gap-1 text-xs text-text-3"><AlertCircle className="h-3 w-3" aria-hidden />Step ID: <code>{p.nodeId}</code></p>
    </div>
  );
}
