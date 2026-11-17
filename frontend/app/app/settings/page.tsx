"use client";

import { Download, KeyRound, Scale, ScrollText, ShieldCheck, UserX } from "lucide-react";
import { useEffect, useState } from "react";

import { Alert, Badge, Button, Card, CardHeader, Code, Field, Input, Loading, PageHeader, Select, Table, Tabs, Textarea } from "@/components/ui";
import { patch, post } from "@/lib/api";
import { useAction, useList, useMe } from "@/lib/hooks";
import type { Workflow } from "@/lib/types";
import { can, dt } from "@/lib/utils";

type Org = { name: string; industry: string | null; size: string | null; country: string | null; language: string; timezone: string; objective: string | null; website: string | null; monthly_budget_usd: string | null; retention_days: number; data_region: string };
type AuditEvt = { id: number; at: string; actor_type: string; actor: string | null; action: string; resource_type: string | null; resource_id: string | null; data: Record<string, unknown>; ip: string | null };
type DSR = { id: string; kind: string; subject_email: string; status: string; result: unknown; created_at: string };
type Assessment = { id: string; purpose: string; risk_class: string; obligations: string[]; status: string; created_at: string };
type Questions = { prohibited: Record<string, string>; high_risk: Record<string, string>; transparency: Record<string, string> };

function General() {
  const org = useList<Org>(["org"], "/org");
  const me = useMe();
  const [f, setF] = useState<Org | null>(null);
  useEffect(() => { if (org.data) setF(org.data); }, [org.data]);
  const save = useAction(() => patch("/org", { ...f, monthly_budget_usd: f!.monthly_budget_usd === "" || f!.monthly_budget_usd == null ? null : Number(f!.monthly_budget_usd) }), { success: "Saved", invalidate: [["org"], ["me"]] });
  if (!f) return <Loading />;
  const s = (k: keyof Org) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const admin = can(me.data?.org?.role, "admin");
  return (
    <Card className="p-6"><fieldset disabled={!admin} className="grid gap-4 sm:grid-cols-2">
      <Field label="Organisation name">{(id) => <Input id={id} value={f.name} onChange={s("name")} />}</Field>
      <Field label="Industry">{(id) => <Input id={id} value={f.industry ?? ""} onChange={s("industry")} />}</Field>
      <Field label="Country">{(id) => <Input id={id} value={f.country ?? ""} onChange={s("country")} />}</Field>
      <Field label="Time zone" help="Used for schedules">{(id) => <Input id={id} value={f.timezone} onChange={s("timezone")} />}</Field>
      <Field label="Monthly AI budget (USD)" help="Hard limit across all agents; model calls stop when reached">{(id) => <Input id={id} type="number" min={0} step="0.01" value={f.monthly_budget_usd ?? ""} onChange={s("monthly_budget_usd")} />}</Field>
      <Field label="Data retention (days)">{(id) => <Input id={id} type="number" min={7} max={3650} value={f.retention_days} onChange={(e) => setF({ ...f, retention_days: Number(e.target.value) })} />}</Field>
      <Field label="Data region">{(id) => <Select id={id} value={f.data_region} onChange={s("data_region")}><option value="eu">EU</option><option value="us">US</option><option value="other">Other / self-hosted</option></Select>}</Field>
      <Field label="Primary objective" className="sm:col-span-2">{(id) => <Textarea id={id} rows={2} value={f.objective ?? ""} onChange={s("objective")} />}</Field>
      <div className="sm:col-span-2"><Button onClick={() => save.mutate(undefined)} loading={save.isPending}>Save</Button></div>
    </fieldset></Card>
  );
}

function Security() {
  const me = useMe();
  const [setup, setSetup] = useState<{ secret: string; otpauth_uri: string } | null>(null);
  const [code, setCode] = useState("");
  const start = useAction(() => post<{ secret: string; otpauth_uri: string }>("/auth/mfa/setup"), { onSuccess: setSetup });
  const enable = useAction(() => post("/auth/mfa/enable", { code }), { success: "Two-factor authentication enabled", invalidate: [["me"]], onSuccess: () => { setSetup(null); setCode(""); } });
  const disable = useAction(() => post("/auth/mfa/disable", { code }), { success: "Two-factor authentication disabled", invalidate: [["me"]], onSuccess: () => setCode("") });
  const everywhere = useAction(() => post("/auth/logout-everywhere"), { onSuccess: () => { window.location.href = "/login"; } });
  const on = me.data?.user.mfa_enabled;
  return (
    <div className="space-y-6">
      <Card><CardHeader title="Two-factor authentication" description="Time-based one-time codes from an authenticator app." action={on ? <Badge tone="good"><ShieldCheck className="h-3 w-3" aria-hidden />enabled</Badge> : <Badge>off</Badge>} />
        <div className="space-y-4 p-5 text-sm">
          {!on && !setup && <Button onClick={() => start.mutate(undefined)} loading={start.isPending}><KeyRound className="h-4 w-4" aria-hidden />Set up</Button>}
          {setup && <><p>Add this key to your authenticator app (or open the link on your phone), then enter the 6-digit code.</p><Code>{setup.secret}</Code>
            <a className="text-accent hover:underline" href={setup.otpauth_uri}>Open in authenticator app</a></>}
          {(setup || on) && <div className="flex max-w-xs gap-2"><Input aria-label="6-digit code" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
            {on ? <Button variant="secondary" disabled={code.length !== 6} onClick={() => disable.mutate(undefined)}>Disable</Button> : <Button disabled={code.length !== 6} onClick={() => enable.mutate(undefined)}>Enable</Button>}</div>}
        </div></Card>
      <Card><CardHeader title="Sessions" description="Sign out of every browser and device." /><div className="p-5"><Button variant="secondary" onClick={() => everywhere.mutate(undefined)}>Sign out everywhere</Button></div></Card>
    </div>
  );
}

function Audit() {
  const [q, setQ] = useState("");
  const log = useList<AuditEvt[]>(["audit", q], `/audit?limit=200${q ? `&q=${encodeURIComponent(q)}` : ""}`);
  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-3"><Input aria-label="Filter audit log" className="max-w-xs" placeholder="Filter by action or person…" value={q} onChange={(e) => setQ(e.target.value)} />
        <p className="text-xs text-text-3">Append-only: entries cannot be edited or deleted.</p></div>
      {log.isLoading ? <Loading /> : <Table head={["When", "Who", "Action", "Resource", "Details"]} empty={!log.data?.length}>
        {log.data?.map((e) => <tr key={e.id}><td className="whitespace-nowrap px-4 py-2.5 text-text-2">{dt(e.at)}</td><td className="px-4 py-2.5">{e.actor ?? e.actor_type}<span className="block text-xs text-text-3">{e.actor_type}{e.ip ? ` · ${e.ip}` : ""}</span></td>
          <td className="px-4 py-2.5 font-mono text-xs">{e.action}</td><td className="px-4 py-2.5 text-xs text-text-2">{e.resource_type}{e.resource_id ? ` ${e.resource_id.slice(0, 8)}` : ""}</td>
          <td className="max-w-xs truncate px-4 py-2.5 font-mono text-xs text-text-3" title={JSON.stringify(e.data)}>{Object.keys(e.data).length ? JSON.stringify(e.data) : ""}</td></tr>)}
      </Table>}
    </>
  );
}

function Privacy() {
  const reqs = useList<DSR[]>(["dsr"], "/privacy/requests");
  const [email, setEmail] = useState("");
  const [kind, setKind] = useState("access");
  const [result, setResult] = useState<unknown>(null);
  const run = useAction(() => post<{ result: unknown }>("/privacy/requests", { kind, subject_email: email }), { invalidate: [["dsr"]], success: "Request completed", onSuccess: (r) => setResult(r.result) });
  return (
    <div className="space-y-6">
      <Card><CardHeader title="Data subject requests (GDPR Art. 15 & 17)" description="Find or erase a person's records held in AgentOS-managed stores. The result lists what is not covered automatically." />
        <div className="flex flex-wrap items-end gap-3 p-5">
          <Field label="Person's email" className="w-72">{(id) => <Input id={id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
          <Field label="Request type" className="w-44">{(id) => <Select id={id} value={kind} onChange={(e) => setKind(e.target.value)}><option value="access">Access (export)</option><option value="erasure">Erasure</option></Select>}</Field>
          <Button variant={kind === "erasure" ? "danger" : "primary"} disabled={!email} loading={run.isPending} onClick={() => (kind !== "erasure" || confirm(`Erase records for ${email}? This cannot be undone.`)) && run.mutate(undefined)}>{kind === "erasure" ? <UserX className="h-4 w-4" aria-hidden /> : <Download className="h-4 w-4" aria-hidden />}Run</Button>
        </div>
        {result != null && <div className="px-5 pb-5"><Code>{JSON.stringify(result, null, 2)}</Code></div>}</Card>
      <Table head={["When", "Type", "Subject", "Status"]} empty={!reqs.data?.length}>{reqs.data?.map((r) => <tr key={r.id}><td className="px-4 py-2.5">{dt(r.created_at)}</td><td className="px-4 py-2.5">{r.kind}</td><td className="px-4 py-2.5">{r.subject_email}</td><td className="px-4 py-2.5">{r.status}</td></tr>)}</Table>
    </div>
  );
}

function AIAct() {
  const me = useMe();
  const qs = useList<Questions>(["aiact-q"], "/compliance/ai-act/questions");
  const list = useList<Assessment[]>(["aiact"], "/compliance/ai-act");
  const wfs = useList<Workflow[]>(["workflows"], "/workflows");
  const [f, setF] = useState({ workflow_id: "", intended_purpose: "", deployment_context: "", answers: {} as Record<string, boolean> });
  const [out, setOut] = useState<{ risk_class: string; obligations: string[]; disclaimer: string } | null>(null);
  const create = useAction(() => post<{ risk_class: string; obligations: string[]; disclaimer: string }>("/compliance/ai-act", { ...f, workflow_id: f.workflow_id || null }), { invalidate: [["aiact"]], onSuccess: setOut });
  const review = useAction((v: { id: string; note: string }) => post(`/compliance/ai-act/${v.id}/review`, { note: v.note }), { success: "Marked as reviewed", invalidate: [["aiact"]] });
  const toggle = (k: string) => setF({ ...f, answers: { ...f.answers, [k]: !f.answers[k] } });
  const tone = (r: string) => r === "prohibited_check" ? "critical" : r === "high_risk_candidate" ? "warning" : "neutral";
  return (
    <div className="space-y-6">
      <Alert tone="warning" title="Self-assessment, not a legal determination">This records how you intend to use AI and flags categories that may carry obligations under the EU AI Act. Completing it does not make a system compliant. Obtain qualified legal review before production use in sensitive domains.</Alert>
      {can(me.data?.org?.role, "manager") && qs.data && (
        <Card><CardHeader title="New assessment" />
          <div className="grid gap-4 p-5 sm:grid-cols-2">
            <Field label="Workflow (optional)">{(id) => <Select id={id} value={f.workflow_id} onChange={(e) => setF({ ...f, workflow_id: e.target.value })}><option value="">Organisation-wide</option>{wfs.data?.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select>}</Field>
            <Field label="Deployment context">{(id) => <Input id={id} value={f.deployment_context} onChange={(e) => setF({ ...f, deployment_context: e.target.value })} placeholder="Who uses it, who is affected" />}</Field>
            <Field label="Intended purpose" className="sm:col-span-2">{(id) => <Textarea id={id} rows={2} value={f.intended_purpose} onChange={(e) => setF({ ...f, intended_purpose: e.target.value })} />}</Field>
            {([["Does the system do any of the following?", qs.data.prohibited], ["Is it used for any of these areas?", qs.data.high_risk], ["Transparency", qs.data.transparency]] as const).map(([h, items]) => (
              <fieldset key={h} className="sm:col-span-2"><legend className="mb-2 text-sm font-medium">{h}</legend><div className="grid gap-1.5 sm:grid-cols-2">{Object.entries(items).map(([k, l]) => (
                <label key={k} className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1 accent-[var(--accent)]" checked={!!f.answers[k]} onChange={() => toggle(k)} />{l}</label>))}</div></fieldset>))}
            <div className="sm:col-span-2"><Button disabled={f.intended_purpose.length < 10} loading={create.isPending} onClick={() => create.mutate(undefined)}><Scale className="h-4 w-4" aria-hidden />Assess</Button></div>
            {out && <div className="space-y-2 sm:col-span-2"><Badge tone={tone(out.risk_class)}>{out.risk_class.replace(/_/g, " ")}</Badge><ul className="list-disc pl-5 text-sm text-text-2">{out.obligations.map((o) => <li key={o}>{o}</li>)}</ul><p className="text-xs text-text-3">{out.disclaimer}</p></div>}
          </div></Card>)}
      <Table head={["Created", "Purpose", "Risk", "Status", ""]} empty={!list.data?.length}>{list.data?.map((a) => (
        <tr key={a.id}><td className="px-4 py-2.5 text-text-2">{dt(a.created_at)}</td><td className="max-w-sm truncate px-4 py-2.5">{a.purpose}</td><td className="px-4 py-2.5"><Badge tone={tone(a.risk_class)}>{a.risk_class.replace(/_/g, " ")}</Badge></td>
          <td className="px-4 py-2.5">{a.status.replace(/_/g, " ")}</td>
          <td className="px-4 py-2.5 text-right">{can(me.data?.org?.role, "owner") && a.status === "needs_legal_review" && a.risk_class !== "prohibited_check" && <Button size="sm" variant="secondary" onClick={() => { const note = prompt("Reviewer note (e.g. name of legal reviewer and date)"); if (note) review.mutate({ id: a.id, note }); }}>Record legal review</Button>}</td></tr>))}</Table>
    </div>
  );
}

export default function Settings() {
  const me = useMe();
  const [tab, setTab] = useState<"general" | "security" | "audit" | "privacy" | "aiact">("general");
  const admin = can(me.data?.org?.role, "admin");
  return (
    <>
      <PageHeader title="Settings" description="Organisation preferences, security, audit log and data controls." />
      <div className="mb-5"><Tabs value={tab} onChange={setTab} items={[{ value: "general", label: "General" }, { value: "security", label: "Security" }, ...(admin ? [{ value: "audit" as const, label: "Audit log" }, { value: "privacy" as const, label: "Privacy" }] : []), { value: "aiact", label: "EU AI Act" }]} /></div>
      {tab === "general" && <General />}{tab === "security" && <Security />}{tab === "audit" && admin && <Audit />}{tab === "privacy" && admin && <Privacy />}{tab === "aiact" && <AIAct />}
      {tab === "general" && <p className="mt-4 flex items-center gap-1 text-xs text-text-3"><ScrollText className="h-3 w-3" aria-hidden />Changes are recorded in the audit log.</p>}
    </>
  );
}
