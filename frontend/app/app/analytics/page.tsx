"use client";

import { Download } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { BarSeries } from "@/components/charts";
import { Card, CardHeader, Loading, PageHeader, Select, Stat, StatusBadge, Table, buttonClass } from "@/components/ui";
import { download } from "@/lib/api";
import { useList } from "@/lib/hooks";
import type { Agent, Execution, Workflow } from "@/lib/types";
import { ago, money, pct } from "@/lib/utils";

type Usage = { series: { day: string; cost_usd: number; tokens_in: number; tokens_out: number; executions: number }[]; by_agent: { agent: string; cost_usd: number; calls: number }[]; by_model: { model: string; cost_usd: number; tokens: number }[]; totals: { cost_usd: number; tokens: number; executions: number }; note: string };
type Perf = { agent_id: string; agent: string; department: string | null; attempted: number; completed: number; failed: number; success_rate: number | null; error_rate: number | null; avg_seconds: number | null; cost_usd: number; avg_cost_usd: number | null; tokens: number; approval_requests: number; human_corrections: number };

export default function Analytics() {
  const [days, setDays] = useState(30);
  const [agent, setAgent] = useState("");
  const [wf, setWf] = useState("");
  const qs = `days=${days}${agent ? `&agent_id=${agent}` : ""}${wf ? `&workflow_id=${wf}` : ""}`;
  const usage = useList<Usage>(["usage", qs], `/analytics/usage?${qs}`);
  const perf = useList<Perf[]>(["perf", days], `/analytics/agents?days=${days}`);
  const agents = useList<Agent[]>(["agents"], "/agents");
  const workflows = useList<Workflow[]>(["workflows"], "/workflows");
  const execs = useList<Execution[]>(["executions", wf], `/executions?limit=50${wf ? `&workflow_id=${wf}` : ""}`);
  const u = usage.data;
  return (
    <>
      <PageHeader title="Analytics" description="Measured from execution records. AgentOS does not estimate savings or revenue." actions={<button onClick={() => download(`/analytics/export.csv?days=${days}`, `agentos-executions-${days}d.csv`)} className={buttonClass({ variant: "secondary" })}><Download className="h-4 w-4" aria-hidden />Export CSV</button>} />
      <div className="mb-5 flex flex-wrap gap-3" role="group" aria-label="Filters">
        <Select aria-label="Date range" className="w-40" value={days} onChange={(e) => setDays(Number(e.target.value))}>{[7, 30, 90, 365].map((d) => <option key={d} value={d}>Last {d} days</option>)}</Select>
        <Select aria-label="Agent" className="w-48" value={agent} onChange={(e) => setAgent(e.target.value)}><option value="">All agents</option>{agents.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>
        <Select aria-label="Workflow" className="w-56" value={wf} onChange={(e) => setWf(e.target.value)}><option value="">All workflows</option>{workflows.data?.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select>
      </div>
      {!u ? <Loading /> : <>
        <div className="grid gap-4 sm:grid-cols-3"><Stat label="AI spend" value={money(u.totals.cost_usd)} hint="measured" /><Stat label="Tokens" value={u.totals.tokens.toLocaleString()} /><Stat label="Workflow executions" value={u.totals.executions} /></div>
        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <Card><CardHeader title="AI spend per day" /><div className="p-4"><BarSeries caption="AI spend (USD)" format={(v) => money(v)} data={u.series.map((s) => ({ label: s.day.slice(5), value: s.cost_usd }))} /></div></Card>
          <Card><CardHeader title="Executions per day" /><div className="p-4"><BarSeries caption="Executions" data={u.series.map((s) => ({ label: s.day.slice(5), value: s.executions }))} /></div></Card>
        </div>
        <p className="mt-2 text-xs text-text-3">{u.note}</p>
      </>}
      <h2 className="mb-3 mt-8 font-semibold">Agent performance</h2>
      {perf.isLoading ? <Loading /> : <Table head={["Agent", "Attempted", "Success", "Errors", "Avg time", "Avg cost", "Total cost", "Approvals", "Human corrections"]} empty={!perf.data?.length}>
        {perf.data?.map((p) => <tr key={p.agent_id}><td className="px-4 py-3 font-medium"><Link href={`/app/workforce/agent?id=${p.agent_id}`} className="hover:underline">{p.agent}</Link></td><td className="px-4 py-3 tabular-nums">{p.attempted}</td>
          <td className="px-4 py-3 tabular-nums">{pct(p.success_rate)}</td><td className="px-4 py-3 tabular-nums">{pct(p.error_rate)}</td><td className="px-4 py-3 tabular-nums">{p.avg_seconds != null ? `${p.avg_seconds}s` : "—"}</td>
          <td className="px-4 py-3 tabular-nums">{money(p.avg_cost_usd)}</td><td className="px-4 py-3 tabular-nums">{money(p.cost_usd)}</td><td className="px-4 py-3 tabular-nums">{p.approval_requests}</td><td className="px-4 py-3 tabular-nums">{p.human_corrections}</td></tr>)}
      </Table>}
      {u && u.by_model.length > 0 && <><h2 className="mb-3 mt-8 font-semibold">By model</h2><Table head={["Model", "Tokens", "Cost"]}>{u.by_model.map((m) => <tr key={m.model}><td className="px-4 py-3">{m.model}</td><td className="px-4 py-3 tabular-nums">{m.tokens.toLocaleString()}</td><td className="px-4 py-3 tabular-nums">{money(m.cost_usd)}</td></tr>)}</Table></>}
      <h2 className="mb-3 mt-8 font-semibold">Recent executions</h2>
      <Table head={["Workflow", "Status", "Mode", "Trigger", "Started", "Cost"]} empty={!execs.data?.length}>
        {execs.data?.map((e) => <tr key={e.id} className="hover:bg-surface-2"><td className="px-4 py-3"><Link href={`/app/executions/view?id=${e.id}`} className="font-medium hover:underline">{e.workflow_name ?? "Agent task"}</Link></td>
          <td className="px-4 py-3"><StatusBadge status={e.status} /></td><td className="px-4 py-3">{e.mode}</td><td className="px-4 py-3">{e.trigger_type}</td><td className="px-4 py-3 text-text-2">{ago(e.created_at)}</td><td className="px-4 py-3 tabular-nums">{money(e.cost_usd)}</td></tr>)}
      </Table>
    </>
  );
}
