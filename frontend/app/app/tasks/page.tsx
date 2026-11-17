"use client";

import { CalendarDays, Columns3, List, Play, Plus, Repeat, Sparkles, Users } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Alert, Badge, Button, Card, Code, Dialog, Field, Input, Loading, PageHeader, Select, StatusBadge, Switch, Table, Tabs, Textarea } from "@/components/ui";
import { post } from "@/lib/api";
import { useAction, useList } from "@/lib/hooks";
import type { Agent, Task, Workflow } from "@/lib/types";
import { ago, dt, money } from "@/lib/utils";

type Parsed = { title: string; description: string; schedule_cron: string | null; schedule_human: string | null; agent_id: string | null; agent_name: string | null; requires_approval: boolean; approval_reason: string | null; suggested_template: string | null };
type Draft = { title: string; description: string; agent_id: string; workflow_id: string; priority: string; due_at: string; schedule_cron: string; requires_approval: boolean; inputs: string; schedule_human?: string | null };
const COLUMNS = ["Draft", "Ready", "Queued", "Running", "Awaiting Approval", "Completed", "Failed"];
const blank = (): Draft => ({ title: "", description: "", agent_id: "", workflow_id: "", priority: "normal", due_at: "", schedule_cron: "", requires_approval: true, inputs: "{}" });

function TaskRow({ t, onOpen }: { t: Task; onOpen: (t: Task) => void }) {
  return (
    <tr className="cursor-pointer hover:bg-surface-2" onClick={() => onOpen(t)}>
      <td className="px-4 py-3"><p className="font-medium">{t.title}</p>{t.schedule_cron && <p className="flex items-center gap-1 text-xs text-text-3"><Repeat className="h-3 w-3" aria-hidden />{t.schedule_cron}</p>}</td>
      <td className="px-4 py-3 text-text-2">{t.agent_name ?? (t.workflow_id ? "Workflow" : "Person")}</td>
      <td className="px-4 py-3"><Badge tone={t.priority === "urgent" ? "critical" : t.priority === "high" ? "warning" : "neutral"}>{t.priority}</Badge></td>
      <td className="px-4 py-3"><StatusBadge status={t.status} /></td><td className="px-4 py-3 text-text-2">{t.due_at ? dt(t.due_at) : "—"}</td><td className="px-4 py-3 text-text-3">{ago(t.created_at)}</td>
    </tr>
  );
}

export default function Tasks() {
  const tasks = useList<Task[]>(["tasks"], "/tasks", { refetchInterval: 8000 });
  const agents = useList<Agent[]>(["agents"], "/agents");
  const workflows = useList<Workflow[]>(["workflows"], "/workflows");
  const [view, setView] = useState<"list" | "kanban" | "calendar" | "workload" | "timeline">("list");
  const [nl, setNl] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const detail = useList<Task>(["task", openId], `/tasks/${openId}`, { enabled: !!openId, refetchInterval: 4000 });

  const parse = useAction((text: string) => post<Parsed>("/tasks/parse", { text }), {
    onSuccess: (p) => { setParsed(p); setDraft({ ...blank(), title: p.title, description: p.description, agent_id: p.agent_id ?? "", schedule_cron: p.schedule_cron ?? "", requires_approval: p.requires_approval, schedule_human: p.schedule_human }); } });
  const create = useAction((d: Draft) => post<Task>("/tasks", {
    title: d.title, description: d.description, agent_id: d.agent_id || null, workflow_id: d.workflow_id || null, priority: d.priority,
    due_at: d.due_at ? new Date(d.due_at).toISOString() : null, schedule_cron: d.schedule_cron || null, requires_approval: d.requires_approval,
    inputs: JSON.parse(d.inputs || "{}"), status: d.agent_id || d.workflow_id ? "Ready" : "Draft" }), {
    success: "Task created", invalidate: [["tasks"]], onSuccess: () => { setDraft(null); setParsed(null); setNl(""); } });
  const act = useAction((v: { id: string; op: string }) => v.op === "run" ? post(`/tasks/${v.id}/run`) : post(`/tasks/${v.id}/transition`, { to: v.op }), {
    success: "Updated", invalidate: [["tasks"], ["task", openId]] });

  const list = tasks.data ?? [];
  const byAgent = useMemo(() => Object.entries(list.reduce<Record<string, Task[]>>((a, t) => { (a[t.agent_name ?? (t.workflow_id ? "Workflows" : "People")] ??= []).push(t); return a; }, {})), [list]);
  const month = useMemo(() => {
    const now = new Date(); const first = new Date(now.getFullYear(), now.getMonth(), 1); const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    return { first, days, offset: (first.getDay() + 6) % 7, label: first.toLocaleDateString(undefined, { month: "long", year: "numeric" }) };
  }, []);
  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setDraft((d) => d && { ...d, [k]: e.target.value });

  return (
    <>
      <PageHeader title="Tasks" description="Give agents work in plain English, on a schedule, or through a workflow." actions={<Button variant="secondary" onClick={() => { setParsed(null); setDraft(blank()); }}><Plus className="h-4 w-4" aria-hidden />Manual task</Button>} />
      <Card className="mb-6 p-4">
        <form className="flex flex-col gap-3 sm:flex-row" onSubmit={(e) => { e.preventDefault(); if (nl.trim().length >= 5) parse.mutate(nl); }}>
          <Input aria-label="Describe a task" value={nl} onChange={(e) => setNl(e.target.value)} placeholder="e.g. Every Monday at 9 AM, review overdue invoices and prepare reminder emails." />
          <Button loading={parse.isPending} disabled={nl.trim().length < 5}><Sparkles className="h-4 w-4" aria-hidden />Create from description</Button>
        </form>
      </Card>
      <div className="mb-4"><Tabs value={view} onChange={setView} items={[{ value: "list", label: "List" }, { value: "kanban", label: "Kanban" }, { value: "calendar", label: "Calendar" }, { value: "workload", label: "Agent workload" }, { value: "timeline", label: "Timeline" }]} /></div>
      {tasks.isLoading ? <Loading /> : <>
        {view === "list" && <Table head={["Task", "Assigned to", "Priority", "Status", "Due", "Created"]} empty={!list.length}>{list.map((t) => <TaskRow key={t.id} t={t} onOpen={(x) => setOpenId(x.id)} />)}</Table>}
        {view === "kanban" && <div className="flex gap-3 overflow-x-auto pb-2">{COLUMNS.map((c) => { const items = list.filter((t) => t.status === c); return (
          <div key={c} className="w-64 shrink-0 rounded-xl bg-surface-2 p-2"><p className="mb-2 flex justify-between px-1 text-xs font-semibold text-text-2"><span>{c}</span><span>{items.length}</span></p>
            <div className="space-y-2">{items.map((t) => <button key={t.id} onClick={() => setOpenId(t.id)} className="w-full rounded-lg border border-border bg-surface p-3 text-left text-sm hover:border-accent/50"><p className="font-medium">{t.title}</p><p className="mt-1 text-xs text-text-3">{t.agent_name ?? "—"}</p></button>)}</div></div>); })}</div>}
        {view === "calendar" && <Card className="p-4"><p className="mb-3 font-medium">{month.label}</p>
          <div className="grid grid-cols-7 gap-1 text-xs">{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d} className="px-1 text-text-3">{d}</div>)}
            {Array.from({ length: month.offset }, (_, i) => <div key={`o${i}`} />)}
            {Array.from({ length: month.days }, (_, i) => { const day = i + 1; const due = list.filter((t) => t.due_at && new Date(t.due_at).getDate() === day && new Date(t.due_at).getMonth() === month.first.getMonth());
              return <div key={day} className="min-h-20 rounded-md border border-border p-1"><span className="text-text-3">{day}</span>{due.map((t) => <button key={t.id} onClick={() => setOpenId(t.id)} className="mt-0.5 block w-full truncate rounded bg-accent-soft px-1 text-left text-accent">{t.title}</button>)}</div>; })}</div>
          <p className="mt-3 text-xs text-text-3">Shows tasks by due date. Recurring tasks run on their schedule shown in the list view.</p></Card>}
        {view === "workload" && <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{byAgent.map(([name, ts]) => (
          <Card key={name} className="p-4"><p className="flex items-center gap-2 font-medium"><Users className="h-4 w-4 text-text-3" aria-hidden />{name}</p>
            <div className="mt-2 flex flex-wrap gap-1.5 text-xs">{COLUMNS.map((c) => { const n = ts.filter((t) => t.status === c).length; return n ? <Badge key={c}>{c}: {n}</Badge> : null; })}</div>
            <p className="mt-2 text-xs text-text-3">Total cost {money(ts.reduce((s, t) => s + t.cost_usd, 0))}</p></Card>))}</div>}
        {view === "timeline" && <Card><ol className="divide-y divide-border">{[...list].sort((a, b) => b.created_at.localeCompare(a.created_at)).map((t) => (
          <li key={t.id}><button onClick={() => setOpenId(t.id)} className="flex w-full items-center gap-4 px-5 py-3 text-left text-sm hover:bg-surface-2"><span className="w-36 shrink-0 text-xs text-text-3">{dt(t.created_at)}</span><span className="flex-1 truncate">{t.title}</span><StatusBadge status={t.status} /></button></li>))}</ol></Card>}
      </>}

      <Dialog open={!!draft} onOpenChange={(v) => !v && setDraft(null)} title={parsed ? "Confirm the task" : "New task"} wide
        description={parsed ? "AgentOS turned your request into this task. Check it before it becomes active." : undefined}
        footer={<><Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button><Button disabled={!draft?.title} loading={create.isPending} onClick={() => draft && create.mutate(draft)}>{draft?.agent_id || draft?.workflow_id ? "Confirm and make ready" : "Save as draft"}</Button></>}>
        {draft && <div className="grid gap-4 sm:grid-cols-2">
          {parsed?.schedule_human && <div className="sm:col-span-2"><Alert tone="info" title="Recurring schedule detected">{parsed.schedule_human} (cron <code>{parsed.schedule_cron}</code>)</Alert></div>}
          {parsed && !parsed.agent_id && <div className="sm:col-span-2"><Alert tone="warning">No matching agent in your workforce{parsed.suggested_template ? ` — try adding the “${parsed.suggested_template}” template from the marketplace` : ""}.</Alert></div>}
          <Field label="Title" className="sm:col-span-2">{(id) => <Input id={id} value={draft.title} onChange={set("title")} />}</Field>
          <Field label="Description" className="sm:col-span-2">{(id) => <Textarea id={id} rows={3} value={draft.description} onChange={set("description")} />}</Field>
          <Field label="Agent">{(id) => <Select id={id} value={draft.agent_id} onChange={set("agent_id")}><option value="">—</option>{agents.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>}</Field>
          <Field label="…or workflow">{(id) => <Select id={id} value={draft.workflow_id} onChange={set("workflow_id")}><option value="">—</option>{workflows.data?.filter((w) => w.published_version).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select>}</Field>
          <Field label="Priority">{(id) => <Select id={id} value={draft.priority} onChange={set("priority")}>{["low", "normal", "high", "urgent"].map((p) => <option key={p}>{p}</option>)}</Select>}</Field>
          <Field label="Due">{(id) => <Input id={id} type="datetime-local" value={draft.due_at} onChange={set("due_at")} />}</Field>
          <Field label="Schedule (cron, optional)" help="e.g. 0 9 * * 1 = Mondays 09:00">{(id) => <Input id={id} value={draft.schedule_cron} onChange={set("schedule_cron")} />}</Field>
          <div className="flex items-center gap-3 pt-6"><Switch checked={draft.requires_approval} onChange={(v) => setDraft({ ...draft, requires_approval: v })} label="Require human review" /><span className="text-sm">Require human review of the result{parsed?.approval_reason && <span className="block text-xs text-text-3">{parsed.approval_reason}</span>}</span></div>
          <Field label="Inputs (JSON)" className="sm:col-span-2">{(id) => <Textarea id={id} rows={3} className="font-mono text-xs" value={draft.inputs} onChange={set("inputs")} />}</Field>
        </div>}
      </Dialog>

      <Dialog open={!!openId} onOpenChange={(v) => !v && setOpenId(null)} title={detail.data?.title ?? "Task"} wide>
        {!detail.data ? <Loading /> : (() => { const t = detail.data; return (
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap items-center gap-2"><StatusBadge status={t.status} /><Badge>{t.priority}</Badge>{t.agent_name && <Badge tone="accent">{t.agent_name}</Badge>}{t.schedule_cron && <Badge><Repeat className="h-3 w-3" aria-hidden />{t.schedule_cron}</Badge>}<Badge>{money(t.cost_usd)}</Badge></div>
            {t.description && <p className="whitespace-pre-wrap text-text-2">{t.description}</p>}
            {t.error && <Alert tone="critical">{t.error}</Alert>}
            {t.result != null && <div><p className="mb-1 font-medium">Result</p><Code>{JSON.stringify(t.result, null, 2)}</Code></div>}
            <div className="flex flex-wrap gap-2">
              {(t.status === "Ready" || t.status === "Failed") && (t.agent_id || t.workflow_id) && <Button size="sm" onClick={() => act.mutate({ id: t.id, op: "run" })}><Play className="h-3.5 w-3.5" aria-hidden />Run now</Button>}
              {t.allowed_transitions.filter((s) => ["Ready", "Paused", "Cancelled", "Draft"].includes(s)).map((s) => <Button key={s} size="sm" variant="secondary" onClick={() => act.mutate({ id: t.id, op: s })}>{s === "Ready" ? "Mark ready" : s === "Paused" ? "Pause" : s === "Cancelled" ? "Cancel" : "Back to draft"}</Button>)}
              {t.status === "Awaiting Approval" && <Link href="/app/approvals" className="text-sm text-accent hover:underline">Review in Inbox →</Link>}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div><p className="mb-1 flex items-center gap-1 font-medium"><List className="h-4 w-4" aria-hidden />History</p><ol className="space-y-1 text-xs text-text-2">{t.events?.map((e, i) => <li key={i}>{dt(e.at)} — {e.from ? `${e.from} → ` : ""}{e.to}{e.note ? ` (${e.note})` : ""}</li>)}</ol></div>
              <div><p className="mb-1 flex items-center gap-1 font-medium"><CalendarDays className="h-4 w-4" aria-hidden />Runs</p><ul className="space-y-1 text-xs">{t.executions?.map((e) => <li key={e.id}><Link className="text-accent hover:underline" href={`/app/executions/view?id=${e.id}`}>{dt(e.created_at)}</Link> · {e.status} · {money(e.cost_usd)}</li>)}{!t.executions?.length && <li className="text-text-3">Not run yet</li>}</ul></div>
            </div>
            <p className="flex items-center gap-1 text-xs text-text-3"><Columns3 className="h-3 w-3" aria-hidden />Status changes are validated on the server.</p>
          </div>); })()}
      </Dialog>
    </>
  );
}
