"use client";

import { useState } from "react";
import { Alert, Button, Field, Input, Select, Textarea } from "@/components/ui";
import { useList } from "@/lib/hooks";
import type { AgentConfig, KB, Provider } from "@/lib/types";

export const MODES: { value: AgentConfig["mode"]; label: string; help: string }[] = [
  { value: "draft_only", label: "Draft only", help: "Creates recommendations or documents. Nothing leaves AgentOS." },
  { value: "approval_required", label: "Approval required", help: "Prepares work; every downstream action waits for a person." },
  { value: "limited_autonomy", label: "Limited autonomy", help: "Low-risk steps continue automatically. Sensitive actions still need approval." },
  { value: "controlled_autonomy", label: "Advanced controlled autonomy", help: "Complex execution under budgets and monitoring. Sensitive actions still need approval." },
];

export type AgentDraft = { name: string; description: string; department: string; escalation_contact: string; monthly_budget_usd: string; config: AgentConfig };

export const emptyConfig = (): AgentConfig => ({
  role: "", instructions: "", mode: "approval_required", provider_id: null, model: null, temperature: 0.2, max_tokens: 1500,
  output_schema: { type: "object", properties: { result: { type: "string" } }, required: ["result"] }, knowledge_base_ids: [], retrieval_k: 5,
});

export function AgentForm({ initial, onSubmit, submitLabel, busy }: { initial: AgentDraft; onSubmit: (d: AgentDraft) => void; submitLabel: string; busy?: boolean }) {
  const [d, setD] = useState<AgentDraft>(initial);
  const [schemaText, setSchemaText] = useState(JSON.stringify(initial.config.output_schema, null, 2));
  const [schemaErr, setSchemaErr] = useState<string>();
  const providers = useList<Provider[]>(["providers"], "/providers");
  const kbs = useList<KB[]>(["kbs"], "/knowledge/bases");
  const c = d.config;
  const setC = (patch: Partial<AgentConfig>) => setD({ ...d, config: { ...c, ...patch } });
  const provider = providers.data?.find((p) => p.id === c.provider_id) ?? providers.data?.find((p) => p.is_default);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    try { const schema = JSON.parse(schemaText); setSchemaErr(undefined); onSubmit({ ...d, config: { ...c, output_schema: schema } }); }
    catch { setSchemaErr("Output format must be valid JSON"); }
  };

  return (
    <form onSubmit={submit} className="space-y-6">
      <section className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">{(id) => <Input id={id} required maxLength={120} value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />}</Field>
        <Field label="Department">{(id) => <Input id={id} value={d.department} onChange={(e) => setD({ ...d, department: e.target.value })} placeholder="e.g. Sales" />}</Field>
        <Field label="Short description" className="sm:col-span-2">{(id) => <Input id={id} value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} />}</Field>
        <Field label="Escalation contact (email)">{(id) => <Input id={id} type="email" value={d.escalation_contact} onChange={(e) => setD({ ...d, escalation_contact: e.target.value })} />}</Field>
        <Field label="Monthly budget (USD)" help="Hard limit; leave empty for none">{(id) => <Input id={id} type="number" min={0} step="0.01" value={d.monthly_budget_usd} onChange={(e) => setD({ ...d, monthly_budget_usd: e.target.value })} />}</Field>
      </section>
      <section className="space-y-4">
        <h3 className="text-sm font-semibold">Job description</h3>
        <Field label="Role and responsibilities">{(id) => <Textarea id={id} rows={2} value={c.role} onChange={(e) => setC({ role: e.target.value })} />}</Field>
        <Field label="Operating instructions" help="Write as you would brief a new colleague. Be specific about what to do when information is missing.">
          {(id) => <Textarea id={id} rows={6} value={c.instructions} onChange={(e) => setC({ instructions: e.target.value })} />}</Field>
        <fieldset><legend className="mb-2 text-sm font-medium">Operating mode</legend>
          <div className="grid gap-2 sm:grid-cols-2">{MODES.map((m) => (
            <label key={m.value} className={`flex cursor-pointer gap-3 rounded-lg border p-3 text-sm ${c.mode === m.value ? "border-accent bg-accent-soft/40" : "border-border"}`}>
              <input type="radio" name="mode" className="mt-0.5 accent-[var(--accent)]" checked={c.mode === m.value} onChange={() => setC({ mode: m.value })} />
              <span><span className="font-medium">{m.label}</span><span className="block text-xs text-text-2">{m.help}</span></span></label>))}
          </div></fieldset>
      </section>
      <section className="grid gap-4 sm:grid-cols-2">
        <h3 className="text-sm font-semibold sm:col-span-2">AI model</h3>
        <Field label="Model connection" help="Add providers under Integrations → AI models">{(id) => (
          <Select id={id} value={c.provider_id ?? ""} onChange={(e) => setC({ provider_id: e.target.value || null })}>
            <option value="">Organisation default{providers.data?.find((p) => p.is_default) ? ` (${providers.data.find((p) => p.is_default)!.name})` : ""}</option>
            {providers.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>)}</Field>
        <Field label="Model" help={provider ? `Default: ${provider.default_model}` : undefined}>{(id) => <Input id={id} value={c.model ?? ""} placeholder={provider?.default_model} onChange={(e) => setC({ model: e.target.value || null })} />}</Field>
        <Field label="Temperature" help="Lower = more consistent">{(id) => <Input id={id} type="number" min={0} max={2} step={0.1} value={c.temperature} onChange={(e) => setC({ temperature: Number(e.target.value) })} />}</Field>
        <Field label="Max output tokens">{(id) => <Input id={id} type="number" min={64} max={32000} value={c.max_tokens} onChange={(e) => setC({ max_tokens: Number(e.target.value) })} />}</Field>
      </section>
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Knowledge access</h3>
        <p className="text-xs text-text-2">The agent can only retrieve from the knowledge bases you tick. This is enforced in the database query, not by instructions.</p>
        {kbs.data?.length ? <div className="grid gap-2 sm:grid-cols-2">{kbs.data.map((k) => (
          <label key={k.id} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
            <input type="checkbox" className="accent-[var(--accent)]" checked={c.knowledge_base_ids.includes(k.id)}
              onChange={(e) => setC({ knowledge_base_ids: e.target.checked ? [...c.knowledge_base_ids, k.id] : c.knowledge_base_ids.filter((x) => x !== k.id) })} />
            {k.name}<span className="ml-auto text-xs capitalize text-text-3">{k.sensitivity}</span></label>))}</div>
          : <p className="text-sm text-text-3">No knowledge bases yet.</p>}
      </section>
      <details className="rounded-lg border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium">Advanced: output format (JSON Schema)</summary>
        <p className="mt-2 text-xs text-text-2">Every response is validated against this schema. Invalid output is repaired once, then the step fails.</p>
        <Textarea aria-label="Output schema" className="mt-2 font-mono text-xs" rows={10} value={schemaText} onChange={(e) => setSchemaText(e.target.value)} />
        {schemaErr && <Alert tone="critical">{schemaErr}</Alert>}
      </details>
      <div className="flex justify-end"><Button loading={busy}>{submitLabel}</Button></div>
    </form>
  );
}

export const toPayload = (d: AgentDraft) => ({
  name: d.name, description: d.description, department: d.department || null, escalation_contact: d.escalation_contact || null,
  monthly_budget_usd: d.monthly_budget_usd === "" ? null : Number(d.monthly_budget_usd), config: d.config,
});
