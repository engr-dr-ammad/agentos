"use client";

import { Bot, CheckCircle2, Circle, DollarSign, Inbox, PlayCircle, XCircle } from "lucide-react";
import Link from "next/link";
import { BarSeries } from "@/components/charts";
import { Card, CardHeader, Loading, PageHeader, Stat, StatusBadge, buttonClass } from "@/components/ui";
import { useList, useMe } from "@/lib/hooks";
import type { Agent, Provider, Workflow } from "@/lib/types";
import { ago, money } from "@/lib/utils";

type Overview = { active_agents: number; total_agents: number; running: number; completed_30d: number; failed_30d: number; pending_approvals: number; spend_month_usd: number; budget_month_usd: number | null; recent: { id: string; workflow: string; status: string; mode: string; created_at: string; cost_usd: number }[] };
type Usage = { series: { day: string; cost_usd: number; executions: number }[] };

export default function OverviewPage() {
  const me = useMe();
  const ov = useList<Overview>(["overview"], "/analytics/overview", { refetchInterval: 10_000 });
  const usage = useList<Usage>(["usage", 30], "/analytics/usage?days=30");
  const agents = useList<Agent[]>(["agents"], "/agents");
  const workflows = useList<Workflow[]>(["workflows"], "/workflows");
  const providers = useList<Provider[]>(["providers"], "/providers");
  if (ov.isLoading) return <Loading rows={4} />;
  const o = ov.data!;
  const checklist = [
    { done: (providers.data ?? []).some((p) => p.kind !== "sandbox"), label: "Connect your own AI model", href: "/app/integrations", optional: true },
    { done: (agents.data?.length ?? 0) > 0, label: "Add your first agent", href: "/app/marketplace" },
    { done: (workflows.data?.length ?? 0) > 0, label: "Build a workflow", href: "/app/studio" },
    { done: (workflows.data ?? []).some((w) => w.published_version), label: "Test and publish it", href: "/app/studio" },
  ];
  const showChecklist = checklist.some((c) => !c.done);
  return (
    <>
      <PageHeader title={`Good to see you, ${me.data?.user.name.split(" ")[0] ?? ""}`} description={`What's happening at ${me.data?.org?.name ?? "your company"}.`}
        actions={<><Link href="/app/tasks" className={buttonClass({ variant: "secondary" })}>New task</Link><Link href="/app/studio" className={buttonClass()}>Open Workflow Studio</Link></>} />
      {showChecklist && (
        <Card className="mb-6">
          <CardHeader title="Get started" description="Four steps to your first automated workflow. The built-in sandbox model works without an API key." />
          <ol className="grid gap-2 p-4 sm:grid-cols-2 lg:grid-cols-4">
            {checklist.map((c) => (
              <li key={c.label}><Link href={c.href} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2.5 text-sm hover:bg-surface-2">
                {c.done ? <CheckCircle2 className="h-4 w-4 text-good" aria-label="Done" /> : <Circle className="h-4 w-4 text-text-3" aria-label="To do" />}
                <span className={c.done ? "text-text-3 line-through" : ""}>{c.label}</span>{c.optional && !c.done && <span className="text-xs text-text-3">(optional)</span>}
              </Link></li>
            ))}
          </ol>
        </Card>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label="Active agents" value={o.active_agents} hint={`${o.total_agents} in workforce`} icon={<Bot className="h-4 w-4" />} />
        <Stat label="Running now" value={o.running} icon={<PlayCircle className="h-4 w-4" />} />
        <Stat label="Completed (30 days)" value={o.completed_30d} icon={<CheckCircle2 className="h-4 w-4" />} />
        <Stat label="Failed (30 days)" value={o.failed_30d} icon={<XCircle className="h-4 w-4" />} />
        <Stat label="Pending approvals" value={<Link href="/app/approvals" className="hover:underline">{o.pending_approvals}</Link>} icon={<Inbox className="h-4 w-4" />} />
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardHeader title="AI spend per day" description={`This month: ${money(o.spend_month_usd)}${o.budget_month_usd != null ? ` of ${money(o.budget_month_usd)} budget` : ""}`} action={<DollarSign className="h-4 w-4 text-text-3" aria-hidden />} />
          <div className="p-4">
            <BarSeries caption="AI spend (USD)" format={(v) => money(v)} data={(usage.data?.series ?? []).map((s) => ({ label: s.day.slice(5), value: s.cost_usd }))} />
            <p className="mt-2 text-xs text-text-3">Calculated from provider-reported tokens and the prices you entered for each model.</p>
          </div>
        </Card>
        <Card>
          <CardHeader title="Recent activity" action={<Link href="/app/analytics" className="text-sm text-accent hover:underline">View all</Link>} />
          {o.recent.length === 0 ? <p className="p-5 text-sm text-text-2">No runs yet. Test a workflow to see activity here.</p> : (
            <ul className="divide-y divide-border">
              {o.recent.map((r) => (
                <li key={r.id}><Link href={`/app/executions/${r.id}`} className="flex items-center justify-between gap-3 px-5 py-3 text-sm hover:bg-surface-2">
                  <span className="min-w-0"><span className="block truncate font-medium">{r.workflow}</span><span className="text-xs text-text-3">{ago(r.created_at)}{r.mode === "test" ? " · test" : ""}</span></span>
                  <StatusBadge status={r.status} /></Link></li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
