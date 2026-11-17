"use client";

import { Bot, Plus, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AgentForm, emptyConfig, toPayload, type AgentDraft } from "@/components/agent-form";
import { Badge, Button, Card, Dialog, EmptyState, Loading, PageHeader, StatusBadge, Tabs, Textarea, buttonClass } from "@/components/ui";
import { post } from "@/lib/api";
import { useAction, useList, useMe } from "@/lib/hooks";
import type { Agent, AgentConfig } from "@/lib/types";
import { can, money, pct } from "@/lib/utils";

type Proposal = { name: string; description: string; department: string | null; template_id: string | null; source: string; config: Partial<AgentConfig> };

export default function Workforce() {
  const me = useMe();
  const router = useRouter();
  const agents = useList<Agent[]>(["agents"], "/agents");
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"describe" | "manual">("describe");
  const [desc, setDesc] = useState("");
  const [draft, setDraft] = useState<AgentDraft | null>(null);
  const propose = useAction((d: string) => post<Proposal>("/agents/propose", { description: d }), {
    onSuccess: (p) => { setDraft({ name: p.name, description: p.description, department: p.department ?? "", escalation_contact: "", monthly_budget_usd: "", config: { ...emptyConfig(), ...p.config } }); setMode("manual"); },
  });
  const create = useAction((d: AgentDraft) => post<Agent>("/agents", toPayload(d)), {
    success: "Agent created as a draft", invalidate: [["agents"]], onSuccess: (a) => router.push(`/app/workforce/${a.id}?tab=test`),
  });
  const manager = can(me.data?.org?.role, "manager");
  const groups = Object.entries((agents.data ?? []).reduce<Record<string, Agent[]>>((acc, a) => { (acc[a.department || "Unassigned"] ??= []).push(a); return acc; }, {}));

  return (
    <>
      <PageHeader title="My AI Workforce" description="Your deployed agents, grouped by department. Agents are software with explicit permissions, not employees."
        actions={manager && <>
          <Link href="/app/marketplace" className={buttonClass({ variant: "secondary" })}>Browse marketplace</Link>
          <Button onClick={() => { setDraft(null); setMode("describe"); setOpen(true); }}><Plus className="h-4 w-4" aria-hidden />Create agent</Button></>} />
      {agents.isLoading ? <Loading /> : !agents.data?.length ? (
        <EmptyState icon={<Bot className="h-8 w-8" />} title="No agents yet" description="Add a ready-made agent from the marketplace or describe one in plain English."
          action={<Link href="/app/marketplace" className={buttonClass()}>Open marketplace</Link>} />
      ) : groups.map(([dept, list]) => (
        <section key={dept} className="mb-8">
          <h2 className="mb-3 text-sm font-semibold text-text-2">{dept} <span className="font-normal text-text-3">· {list.length}</span></h2>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {list.map((a) => (
              <Link key={a.id} href={`/app/workforce/${a.id}`}>
                <Card className="h-full p-5 transition-colors hover:border-accent/50">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-lg bg-accent-soft text-accent"><Bot className="h-4 w-4" aria-hidden /></span>
                      <div><h3 className="font-medium">{a.name}</h3><p className="text-xs text-text-3">v{a.current_version} · {a.config?.mode.replace(/_/g, " ")}</p></div></div>
                    <StatusBadge status={a.status} />
                  </div>
                  <p className="mt-3 line-clamp-2 text-sm text-text-2">{a.description || a.config?.role}</p>
                  <dl className="mt-4 grid grid-cols-3 gap-2 border-t border-border pt-3 text-xs">
                    <div><dt className="text-text-3">Tasks</dt><dd className="font-medium tabular-nums">{a.stats?.attempted ?? 0}</dd></div>
                    <div><dt className="text-text-3">Success</dt><dd className="font-medium tabular-nums">{pct(a.stats?.success_rate)}</dd></div>
                    <div><dt className="text-text-3">Cost</dt><dd className="font-medium tabular-nums">{money(a.stats?.cost_usd ?? 0)}</dd></div>
                  </dl>
                  {(a.config?.knowledge_base_ids.length ?? 0) > 0 && <Badge className="mt-3">{a.config!.knowledge_base_ids.length} knowledge base(s)</Badge>}
                </Card>
              </Link>
            ))}
          </div>
        </section>
      ))}
      <Dialog open={open} onOpenChange={setOpen} title="Create an agent" wide description="Describe the agent in plain English, or configure every detail yourself.">
        <div className="mb-4"><Tabs value={mode} onChange={setMode} items={[{ value: "describe", label: "Describe your agent" }, { value: "manual", label: "Configure manually" }]} /></div>
        {mode === "describe" ? (
          <div className="space-y-3">
            <Textarea aria-label="Describe the agent" rows={5} value={desc} onChange={(e) => setDesc(e.target.value)}
              placeholder="I want an agent that reads incoming customer enquiries, checks our service catalogue, drafts a quotation and asks me to approve it before sending." />
            <div className="flex justify-end"><Button onClick={() => propose.mutate(desc)} loading={propose.isPending} disabled={desc.trim().length < 10}><Sparkles className="h-4 w-4" aria-hidden />Propose configuration</Button></div>
            <p className="text-xs text-text-3">With a connected model, AgentOS drafts the configuration with AI; otherwise it starts from the closest template. Nothing is saved until you confirm.</p>
          </div>
        ) : (
          <AgentForm key={draft?.name ?? "new"} initial={draft ?? { name: "", description: "", department: "", escalation_contact: "", monthly_budget_usd: "", config: emptyConfig() }}
            submitLabel="Create agent" busy={create.isPending} onSubmit={(d) => create.mutate(d)} />
        )}
      </Dialog>
    </>
  );
}
