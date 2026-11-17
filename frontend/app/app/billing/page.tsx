"use client";

import { Check, ExternalLink } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Alert, Badge, Button, Card, CardHeader, Loading, PageHeader, Stat, Table } from "@/components/ui";
import { post } from "@/lib/api";
import { useAction, useList, useMe } from "@/lib/hooks";
import { can, dt, money } from "@/lib/utils";

type Plan = { label: string; agents: number | null; workflows: number | null; executions_per_month: number | null; members: number | null; documents: number | null; integrations: number | null };
type Billing = { plan: string; plans: Record<string, Plan>; status: string; current_period_end: string | null; stripe_enabled: boolean; note: string;
  usage: { agents: number; workflows: number; documents: number; members: number; executions_this_month: number; ai_cost_this_month_usd: number; tokens_in: number; tokens_out: number };
  invoices: { id: string; amount: number; currency: string; status: string; url: string | null; created_at: string }[] };

function BillingPage() {
  const me = useMe();
  const status = useSearchParams().get("status");
  const b = useList<Billing>(["billing"], "/billing");
  const owner = can(me.data?.org?.role, "owner");
  const checkout = useAction((plan: string) => post<{ url?: string; sandbox?: boolean }>("/billing/checkout", { plan }), {
    invalidate: [["billing"], ["me"]], success: (r) => r.sandbox ? "Plan changed (billing sandbox — no payment taken)" : "Redirecting to checkout…",
    onSuccess: (r) => { if (r.url) window.location.href = r.url; } });
  const portal = useAction(() => post<{ url: string }>("/billing/portal"), { onSuccess: (r) => { window.location.href = r.url; } });
  if (!b.data) return <Loading />;
  const d = b.data;
  const lim = d.plans[d.plan];
  const use = (n: number, cap: number | null) => cap == null ? `${n} (unlimited)` : `${n} / ${cap}`;
  return (
    <>
      <PageHeader title="Billing" description={d.note} actions={owner && d.stripe_enabled && <Button variant="secondary" onClick={() => portal.mutate(undefined)}><ExternalLink className="h-4 w-4" aria-hidden />Manage payment</Button>} />
      {status === "success" && <div className="mb-4"><Alert tone="good">Thanks — your subscription is being activated.</Alert></div>}
      {!d.stripe_enabled && <div className="mb-4"><Alert tone="warning" title="Billing sandbox">No payment provider is configured on this deployment. Plan changes apply immediately without payment so you can explore limits.</Alert></div>}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Plan" value={lim.label} hint={d.current_period_end ? `Renews ${dt(d.current_period_end)}` : d.status} />
        <Stat label="Executions this month" value={use(d.usage.executions_this_month, lim.executions_per_month)} />
        <Stat label="AI cost this month" value={money(d.usage.ai_cost_this_month_usd)} hint="billed by your model provider" />
        <Stat label="Tokens this month" value={(d.usage.tokens_in + d.usage.tokens_out).toLocaleString()} />
      </div>
      <Card className="mt-6"><CardHeader title="Usage against limits" />
        <dl className="grid gap-4 p-5 text-sm sm:grid-cols-3">{(["agents", "workflows", "members", "documents"] as const).map((k) => <div key={k}><dt className="capitalize text-text-3">{k}</dt><dd className="font-medium tabular-nums">{use(d.usage[k], lim[k])}</dd></div>)}</dl></Card>
      <h2 className="mb-3 mt-8 font-semibold">Plans</h2>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">{Object.entries(d.plans).map(([id, p]) => (
        <Card key={id} className={`flex flex-col p-5 ${id === d.plan ? "border-accent" : ""}`}>
          <div className="flex items-center justify-between"><h3 className="font-semibold">{p.label}</h3>{id === d.plan && <Badge tone="accent">current</Badge>}</div>
          <ul className="mt-3 flex-1 space-y-1.5 text-sm text-text-2">{(["agents", "workflows", "executions_per_month", "members"] as const).map((k) => <li key={k} className="flex gap-2"><Check className="mt-0.5 h-4 w-4 text-good" aria-hidden />{p[k] == null ? "Unlimited" : p[k]!.toLocaleString()} {k.replace(/_/g, " ")}</li>)}</ul>
          {owner && id !== d.plan && <Button className="mt-4" variant={id === "enterprise" ? "secondary" : "primary"} onClick={() => checkout.mutate(id)} loading={checkout.isPending && checkout.variables === id}>{id === "enterprise" && d.stripe_enabled ? "Contact sales" : `Switch to ${p.label}`}</Button>}
        </Card>))}</div>
      <h2 className="mb-3 mt-8 font-semibold">Invoices</h2>
      <Table head={["Date", "Amount", "Status", ""]} empty={!d.invoices.length}>{d.invoices.map((i) => <tr key={i.id}><td className="px-4 py-3">{dt(i.created_at)}</td><td className="px-4 py-3 tabular-nums">{i.amount.toLocaleString(undefined, { style: "currency", currency: i.currency.toUpperCase() })}</td><td className="px-4 py-3">{i.status}</td><td className="px-4 py-3 text-right">{i.url && <a href={i.url} className="text-accent hover:underline" target="_blank" rel="noreferrer">View</a>}</td></tr>)}</Table>
    </>
  );
}

export default function Page() { return <Suspense><BillingPage /></Suspense>; }
