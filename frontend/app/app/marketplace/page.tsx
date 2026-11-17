"use client";

import { Bot, FlaskConical, Plus, Search, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Badge, Button, Card, Code, Dialog, Input, Loading, PageHeader } from "@/components/ui";
import { post } from "@/lib/api";
import { useAction, useList, useMe } from "@/lib/hooks";
import type { Agent, Template } from "@/lib/types";
import { can } from "@/lib/utils";

export default function Marketplace() {
  const me = useMe();
  const router = useRouter();
  const templates = useList<Template[]>(["templates"], "/templates");
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("All");
  const [open, setOpen] = useState<Template | null>(null);
  const add = useAction((v: { id: string; test: boolean }) => post<Agent>("/agents/from-template", { template_id: v.id }), {
    success: "Added to your workspace as a draft", invalidate: [["agents"]],
    onSuccess: (a, v) => router.push(`/app/workforce/agent?id=${a.id}${v.test ? "&tab=test" : ""}`),
  });
  const cats = useMemo(() => ["All", ...Array.from(new Set((templates.data ?? []).map((t) => t.category))).sort()], [templates.data]);
  const list = (templates.data ?? []).filter((t) => (cat === "All" || t.category === cat) &&
    (!q || `${t.name} ${t.description} ${t.industries.join(" ")} ${t.capabilities.join(" ")}`.toLowerCase().includes(q.toLowerCase())));
  const manager = can(me.data?.org?.role, "manager");

  return (
    <>
      <PageHeader title="Agent Marketplace" description="Ready-made, validated agent templates. Adding one creates a draft you can test and adjust; it gets no permissions until you connect apps and activate it." />
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-xs"><Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-text-3" aria-hidden />
          <Input aria-label="Search agents" placeholder="Search agents, industries…" className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Categories">
          {cats.map((c) => <button key={c} onClick={() => setCat(c)} aria-pressed={cat === c}
            className={`rounded-full border px-3 py-1 text-sm ${cat === c ? "border-accent bg-accent-soft text-accent" : "border-border text-text-2 hover:bg-surface-2"}`}>{c}</button>)}
        </div>
      </div>
      {templates.isLoading ? <Loading /> : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {list.map((t) => (
            <Card key={t.id} className="flex flex-col p-5">
              <div className="flex items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-lg bg-accent-soft text-accent"><Bot className="h-4 w-4" aria-hidden /></span>
                <div><h3 className="font-medium">{t.name}</h3><p className="text-xs text-text-3">{t.category} · {t.department} · v{t.version}</p></div></div>
              <p className="mt-3 text-sm text-text-2">{t.description}</p>
              <dl className="mt-3 space-y-1 text-xs text-text-2">
                <div><dt className="inline font-medium text-text">Inputs: </dt><dd className="inline">{t.inputs}</dd></div>
                <div><dt className="inline font-medium text-text">Outputs: </dt><dd className="inline">{t.outputs}</dd></div>
                {t.required_integrations.length > 0 && <div><dt className="inline font-medium text-text">Needs: </dt><dd className="inline">{t.required_integrations.join(", ")}</dd></div>}
                {t.approvals.length > 0 && <div className="flex gap-1"><ShieldCheck className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden /><dd>{t.approvals.join("; ")}</dd></div>}
              </dl>
              <div className="mt-3 flex flex-wrap gap-1">{t.industries.slice(0, 3).map((i) => <Badge key={i}>{i === "all" ? "All industries" : i}</Badge>)}<Badge>Cost: depends on your model</Badge></div>
              <div className="mt-auto flex flex-wrap gap-2 pt-4">
                <Button size="sm" variant="ghost" onClick={() => setOpen(t)}>View details</Button>
                {manager && <><Button size="sm" variant="secondary" onClick={() => add.mutate({ id: t.id, test: true })} disabled={add.isPending}><FlaskConical className="h-3.5 w-3.5" aria-hidden />Try in sandbox</Button>
                  <Button size="sm" onClick={() => add.mutate({ id: t.id, test: false })} disabled={add.isPending}><Plus className="h-3.5 w-3.5" aria-hidden />Add to workspace</Button></>}
              </div>
            </Card>
          ))}
        </div>
      )}
      <Dialog open={!!open} onOpenChange={(v) => !v && setOpen(null)} title={open?.name ?? ""} description={open?.description} wide>
        {open && (
          <div className="grid gap-5 text-sm sm:grid-cols-2">
            {([["Capabilities", open.capabilities], ["Triggers", open.triggers], ["Permissions", open.permissions], ["Safety constraints", open.safety_constraints], ["Human approvals", open.approvals], ["Industries", open.industries]] as const).map(([h, items]) => (
              <div key={h}><h4 className="font-medium">{h}</h4><ul className="mt-1 list-disc pl-5 text-text-2">{items.length ? items.map((i) => <li key={i}>{i}</li>) : <li>None</li>}</ul></div>))}
            <div className="sm:col-span-2"><h4 className="mb-1 font-medium">Output schema</h4><Code>{JSON.stringify(open.output_schema, null, 2)}</Code></div>
            <p className="text-xs text-text-3 sm:col-span-2">Default mode: {open.default_mode.replace(/_/g, " ")}. Usage cost depends on the model you connect and is tracked per run.</p>
          </div>
        )}
      </Dialog>
    </>
  );
}
