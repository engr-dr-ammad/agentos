"use client";

import { FileUp, Plus, Sparkles, Workflow as WorkflowIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button, Card, Dialog, EmptyState, Field, Input, Loading, PageHeader, StatusBadge, Textarea } from "@/components/ui";
import { get, post } from "@/lib/api";
import { useAction, useList, useMe } from "@/lib/hooks";
import type { Agent, Connection, Definition, Workflow } from "@/lib/types";
import { ago, can } from "@/lib/utils";

async function ensureAgent(templateId: string, existing: Agent[]): Promise<Agent> {
  const found = existing.find((a) => a.template_id === templateId);
  const a = found ?? await post<Agent>("/agents/from-template", { template_id: templateId });
  if (a.status !== "active") await post(`/agents/${a.id}/status`, { status: "active" });
  return a;
}

/** The reference "Customer enquiry → approved quotation" workflow. */
async function buildQuotationStarter(): Promise<Definition> {
  const agents = await get<Agent[]>("/agents");
  const conns = await get<Connection[]>("/connections");
  const rec = await ensureAgent("receptionist", agents);
  const sales = await ensureAgent("sales-quotation", agents);
  const email = conns.find((c) => c.kind === "smtp" && c.status === "active") ?? conns.find((c) => c.kind === "sandbox_email");
  const crm = conns.find((c) => c.kind === "sandbox_crm");
  const n = (id: string, type: string, x: number, y: number, label: string, config: Record<string, unknown>) => ({ id, type, position: { x, y }, data: { label, config } });
  return {
    nodes: [
      n("enquiry", "trigger.webhook", 0, 0, "Customer enquiry form", { sample_input: { customer_name: "Ada Example", email: "ada@example.com", message: "Hello, could you quote 12 ergonomic office chairs and 2 standing desks?" } }),
      n("reception", "agent", 280, 0, "Receptionist", { agent_id: rec.id, task: "Read the enquiry and extract the customer's structured request.", input: "{{ trigger }}", timeout_seconds: 300, max_attempts: 3, on_error: "fail" }),
      n("sales", "agent", 560, 0, "Quotation Agent", { agent_id: sales.id, task: "Draft a quotation using only catalogue prices.", input: "{{ nodes.reception.result }}", timeout_seconds: 300, max_attempts: 3, on_error: "fail" }),
      n("pricing", "finance.price_check", 840, 0, "Finance validation", { items: "{{ nodes.sales.result.line_items }}", currency: "EUR", tax_rate_pct: 19, max_discount_pct: 15, min_unit_price: 0 }),
      n("approval", "human.approval", 0, 220, "Manager approval", { title: "Send quotation to {{ nodes.reception.result.customer_name }}", action_node: "send", reason: "{{ nodes.sales.result.cover_note }}", amount: "{{ nodes.pricing.total }}", approver_role: "manager", expires_hours: 72, risks: "Prices and terms become a commitment once sent." }),
      n("review", "human.task", 1120, 0, "Escalate pricing issue", { title: "Quotation for {{ nodes.reception.result.customer_name }} broke pricing rules", description: "{{ nodes.pricing.violations | join('\\n') }}", priority: "high" }),
      n("send", "action.send_email", 280, 220, "Send quotation", { connection_id: email?.id, to: "{{ nodes.reception.result.email }}", subject: "Your quotation", body: "Dear {{ nodes.reception.result.customer_name }},\n\n{{ nodes.sales.result.cover_note }}\n\n{% for l in nodes.pricing.lines %}- {{ l.quantity }} × {{ l.description }} @ {{ l.unit_price }} = {{ l.line_total }}\n{% endfor %}\nNet: {{ nodes.pricing.net }} {{ nodes.pricing.currency }}\nVAT: {{ nodes.pricing.tax }}\nTotal: {{ nodes.pricing.total }} {{ nodes.pricing.currency }}", max_attempts: 3, on_error: "fail" }),
      n("crm", "action.crm_upsert", 560, 220, "Update CRM", { connection_id: crm?.id, key: "{{ nodes.reception.result.email }}", fields: { name: "{{ nodes.reception.result.customer_name }}", status: "quoted", last_quote_total: "{{ nodes.pricing.total }}" }, max_attempts: 3, on_error: "fail" }),
      n("end", "control.end", 840, 220, "Done", { result: { customer: "{{ nodes.reception.result.email }}", total: "{{ nodes.pricing.total }}", currency: "{{ nodes.pricing.currency }}" } }),
    ],
    edges: [["enquiry", "reception"], ["reception", "sales"], ["sales", "pricing"], ["pricing", "approval", "ok"], ["pricing", "review", "violation"], ["approval", "send"], ["send", "crm"], ["crm", "end"]]
      .map(([s, t, h], i) => ({ id: `e${i}`, source: s!, target: t!, sourceHandle: h ?? null })),
  };
}

export default function Studio() {
  const me = useMe();
  const router = useRouter();
  const wfs = useList<Workflow[]>(["workflows"], "/workflows");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [starting, setStarting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const create = useAction((v: { name: string; description: string; draft?: Definition }) => post<Workflow>("/workflows", v), {
    invalidate: [["workflows"]], onSuccess: (w) => router.push(`/app/studio/edit?id=${w.id}`) });
  const manager = can(me.data?.org?.role, "manager");

  const starter = async () => {
    setStarting(true);
    try { create.mutate({ name: "Customer enquiry → approved quotation", description: "Reference workflow: enquiry, quotation draft, deterministic pricing, approval, email, CRM.", draft: await buildQuotationStarter() }); }
    catch (e) { toast.error((e as Error).message); } finally { setStarting(false); }
  };
  const importFile = async (f: File) => {
    try { const w = await post<Workflow>("/workflows/import", JSON.parse(await f.text())); router.push(`/app/studio/edit?id=${w.id}`); }
    catch (e) { toast.error(e instanceof SyntaxError ? "That file is not valid JSON" : (e as Error).message); }
  };

  return (
    <>
      <PageHeader title="Workflow Studio" description="Design how your agents, people and apps work together. Drafts never affect published versions."
        actions={manager && <>
          <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
          <Button variant="secondary" onClick={() => fileRef.current?.click()}><FileUp className="h-4 w-4" aria-hidden />Import</Button>
          <Button variant="secondary" onClick={starter} loading={starting || create.isPending}><Sparkles className="h-4 w-4" aria-hidden />Quotation starter</Button>
          <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" aria-hidden />New workflow</Button></>} />
      {wfs.isLoading ? <Loading /> : !wfs.data?.length ? (
        <EmptyState icon={<WorkflowIcon className="h-8 w-8" />} title="No workflows yet"
          description="Start from the quotation starter to see a complete example — enquiry, AI drafting, pricing rules, approval, email and CRM — or build your own from scratch."
          action={manager && <Button onClick={starter} loading={starting}><Sparkles className="h-4 w-4" aria-hidden />Use the quotation starter</Button>} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {wfs.data.map((w) => (
            <Link key={w.id} href={`/app/studio/edit?id=${w.id}`}><Card className="h-full p-5 transition-colors hover:border-accent/50">
              <div className="flex items-start justify-between gap-2"><h3 className="font-medium">{w.name}</h3><StatusBadge status={w.status} /></div>
              <p className="mt-1 line-clamp-2 text-sm text-text-2">{w.description || "No description"}</p>
              <p className="mt-4 text-xs text-text-3">{w.node_count} steps · {w.published_version ? `v${w.published_version} live` : "not published"} · last run {ago(w.last_run_at)}</p>
            </Card></Link>
          ))}
        </div>
      )}
      <Dialog open={open} onOpenChange={setOpen} title="New workflow"
        footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate({ name, description: desc })}>Create</Button></>}>
        <div className="space-y-4">
          <Field label="Name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} autoFocus />}</Field>
          <Field label="What does it do?">{(id) => <Textarea id={id} rows={3} value={desc} onChange={(e) => setDesc(e.target.value)} />}</Field>
        </div>
      </Dialog>
    </>
  );
}
