"use client";

import { ArrowLeft, FlaskConical, History, Play, Settings2 } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { AgentForm, toPayload } from "@/components/agent-form";
import { Alert, Badge, Button, Card, CardHeader, Code, Field, Loading, PageHeader, Select, Stat, StatusBadge, Tabs, Textarea } from "@/components/ui";
import { del, patch, post } from "@/lib/api";
import { useAction, useList, useMe } from "@/lib/hooks";
import type { Agent } from "@/lib/types";
import { ago, can, money, pct } from "@/lib/utils";

type TestResult = { status: string; error: string | null; output: { result: unknown; sources: { id: number; document: string; chunk: number }[]; model: string; provider: string; sandbox: boolean } | null; tokens_in: number; tokens_out: number; cost_usd: number; duration_seconds: number | null };
type Tab = "configure" | "test" | "versions";

function AgentDetail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const sp = useSearchParams();
  const me = useMe();
  const [tab, setTab] = useState<Tab>((sp.get("tab") as Tab) || "configure");
  const agent = useList<Agent>(["agent", id], `/agents/${id}`);
  const [task, setTask] = useState("Process this input and produce the expected output.");
  const [input, setInput] = useState('{\n  "message": "Hello, I would like a quote for 10 office chairs. — Ada (ada@example.com)"\n}');
  const [version, setVersion] = useState<string>("");
  const [result, setResult] = useState<TestResult | null>(null);
  const [inputErr, setInputErr] = useState<string>();
  const manager = can(me.data?.org?.role, "manager");

  const save = useAction((d: Parameters<typeof toPayload>[0]) => patch(`/agents/${id}`, { ...toPayload(d), note: "Edited in UI" }), { success: "Saved as a new version", invalidate: [["agent", id], ["agents"]] });
  const status = useAction((s: string) => post(`/agents/${id}/status`, { status: s }), { success: (r) => `Agent ${(r as { status: string }).status}`, invalidate: [["agent", id], ["agents"]] });
  const rollback = useAction((v: number) => post(`/agents/${id}/rollback`, { version: v }), { success: "Rolled back (saved as a new version)", invalidate: [["agent", id]] });
  const remove = useAction(() => del(`/agents/${id}`), { success: "Agent deleted", invalidate: [["agents"]], onSuccess: () => router.push("/app/workforce") });
  const test = useAction(async () => {
    let parsed: unknown;
    try { parsed = JSON.parse(input); setInputErr(undefined); } catch { parsed = input; }
    return post<TestResult>(`/agents/${id}/test`, { task, input: parsed, version: version ? Number(version) : null });
  }, { onSuccess: (r) => setResult(r) });

  if (agent.isLoading || !agent.data) return <Loading rows={5} />;
  const a = agent.data;
  return (
    <>
      <Link href="/app/workforce" className="mb-3 inline-flex items-center gap-1 text-sm text-text-2 hover:text-text"><ArrowLeft className="h-4 w-4" aria-hidden />Workforce</Link>
      <PageHeader title={a.name} description={<span className="flex flex-wrap items-center gap-2"><StatusBadge status={a.status} /><Badge>v{a.current_version}</Badge><Badge>{a.config?.mode.replace(/_/g, " ")}</Badge>{a.department && <Badge>{a.department}</Badge>}</span>}
        actions={manager && <>
          {a.status !== "active" ? <Button onClick={() => status.mutate("active")} loading={status.isPending}><Play className="h-4 w-4" aria-hidden />Activate</Button>
            : <Button variant="secondary" onClick={() => status.mutate("paused")}>Pause</Button>}
          {a.status !== "disabled" && <Button variant="ghost" onClick={() => status.mutate("disabled")}>Disable</Button>}
          <Button variant="ghost" onClick={() => confirm(`Delete ${a.name}? Workflows using it will fail validation.`) && remove.mutate(undefined)}>Delete</Button></>} />
      {a.status === "draft" && <div className="mb-4"><Alert tone="info" title="Test before activating">Run a sample task below. Draft agents can be tested but don't run in published workflows.</Alert></div>}
      <div className="mb-6 grid gap-4 sm:grid-cols-4">
        <Stat label="Tasks attempted" value={a.stats?.attempted ?? 0} /><Stat label="Success rate" value={pct(a.stats?.success_rate)} />
        <Stat label="Avg duration" value={a.stats?.avg_seconds != null ? `${a.stats.avg_seconds}s` : "—"} /><Stat label="Total cost" value={money(a.stats?.cost_usd ?? 0)} />
      </div>
      <div className="mb-4"><Tabs value={tab} onChange={setTab} items={[{ value: "configure", label: "Configure" }, { value: "test", label: "Test" }, { value: "versions", label: "Versions", count: a.versions?.length }]} /></div>
      {tab === "configure" && (
        <Card className="p-6">
          {!manager && <div className="mb-4"><Alert>You can view this agent. Editing requires the manager role.</Alert></div>}
          <AgentForm key={a.current_version} submitLabel="Save new version" busy={save.isPending} onSubmit={(d) => manager && save.mutate(d)}
            initial={{ name: a.name, description: a.description, department: a.department ?? "", escalation_contact: a.escalation_contact ?? "", monthly_budget_usd: a.monthly_budget_usd ?? "", config: a.config! }} />
        </Card>
      )}
      {tab === "test" && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card><CardHeader title="Sample task" description="Runs once in test mode. Nothing is sent externally." action={<FlaskConical className="h-4 w-4 text-text-3" />} />
            <div className="space-y-4 p-5">
              <Field label="Objective">{(fid) => <Textarea id={fid} rows={2} value={task} onChange={(e) => setTask(e.target.value)} />}</Field>
              <Field label="Input (JSON or text)" error={inputErr}>{(fid) => <Textarea id={fid} rows={8} className="font-mono text-xs" value={input} onChange={(e) => setInput(e.target.value)} />}</Field>
              <Field label="Version">{(fid) => <Select id={fid} value={version} onChange={(e) => setVersion(e.target.value)}><option value="">Current (v{a.current_version})</option>{a.versions?.map((v) => <option key={v.version} value={v.version}>v{v.version} — {v.note}</option>)}</Select>}</Field>
              <Button onClick={() => test.mutate(undefined)} loading={test.isPending}><Play className="h-4 w-4" aria-hidden />Run test</Button>
            </div></Card>
          <Card><CardHeader title="Result" />
            <div className="space-y-3 p-5">
              {!result ? <p className="text-sm text-text-2">Run a test to see the output, sources, tokens and cost.</p> : <>
                <div className="flex flex-wrap items-center gap-2 text-xs"><StatusBadge status={result.status} />
                  {result.output?.sandbox && <Badge tone="warning">Sandbox model · simulated output</Badge>}
                  {result.output && <Badge>{result.output.provider} · {result.output.model}</Badge>}
                  <Badge>{result.tokens_in}+{result.tokens_out} tokens</Badge><Badge>{money(result.cost_usd)}</Badge>
                  {result.duration_seconds != null && <Badge>{result.duration_seconds.toFixed(1)}s</Badge>}</div>
                {result.error && <Alert tone="critical">{result.error}</Alert>}
                {result.output && <Code>{JSON.stringify(result.output.result, null, 2)}</Code>}
                {!!result.output?.sources.length && <div className="text-sm"><p className="font-medium">Sources used</p><ul className="mt-1 text-text-2">{result.output.sources.map((s) => <li key={s.id}>[{s.id}] {s.document} · chunk {s.chunk}</li>)}</ul></div>}
              </>}
            </div></Card>
        </div>
      )}
      {tab === "versions" && (
        <Card><ul className="divide-y divide-border">{a.versions?.map((v) => (
          <li key={v.version} className="flex items-center justify-between gap-4 px-5 py-3 text-sm">
            <span className="flex items-center gap-3"><History className="h-4 w-4 text-text-3" aria-hidden /><span className="font-medium">v{v.version}</span><span className="text-text-2">{v.note}</span>{v.version === a.current_version && <Badge tone="accent">current</Badge>}</span>
            <span className="flex items-center gap-3 text-text-3">{ago(v.created_at)}{manager && v.version !== a.current_version && <Button size="sm" variant="secondary" onClick={() => rollback.mutate(v.version)}><Settings2 className="h-3.5 w-3.5" aria-hidden />Restore</Button>}</span>
          </li>))}</ul></Card>
      )}
    </>
  );
}

export default function Page() {
  return <Suspense><AgentDetail /></Suspense>;
}
