"use client";

import { Bot, Check, Clock, FileText, MessageSquareWarning, ShieldAlert, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Alert, Badge, Button, Card, Code, Dialog, EmptyState, Loading, PageHeader, StatusBadge, Tabs, Textarea } from "@/components/ui";
import { post } from "@/lib/api";
import { useAction, useList } from "@/lib/hooks";
import type { Approval, Execution, Task } from "@/lib/types";
import { ago, dt } from "@/lib/utils";

function Payload({ a }: { a: Approval }) {
  const r = a.payload.request;
  if (a.payload.action === "action.send_email") return (
    <div className="rounded-lg border border-border">
      <div className="space-y-1 border-b border-border px-4 py-2 text-sm"><p><span className="text-text-3">To:</span> {String(r.to)}</p><p><span className="text-text-3">Subject:</span> {String(r.subject)}</p></div>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap px-4 py-3 font-sans text-sm text-text">{String(r.body)}</pre>
    </div>
  );
  return <Code>{JSON.stringify(r, null, 2)}</Code>;
}

function Card_({ a }: { a: Approval }) {
  const [mode, setMode] = useState<null | "reject" | "request_changes">(null);
  const [comment, setComment] = useState("");
  const decide = useAction((d: { decision: string; comment?: string }) => post(`/approvals/${a.id}/decide`, { ...d, payload_hash: a.payload_hash }), {
    success: (r) => `Approval ${(r as { status: string }).status.replace("_", " ")}`, invalidate: [["approvals"], ["overview"]], onSuccess: () => setMode(null) });
  const expiresSoon = a.expires_at && new Date(a.expires_at).getTime() - Date.now() < 6 * 3600_000;
  const action = a.payload.action.replace("action.", "").replace(/_/g, " ");
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div>
          <div className="flex items-center gap-2"><ShieldAlert className="h-4 w-4 text-warning" aria-hidden /><h2 className="font-semibold">{a.title}</h2></div>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-text-3">
            {a.requested_by_agent && <span className="inline-flex items-center gap-1"><Bot className="h-3 w-3" aria-hidden />Prepared by {a.requested_by_agent}</span>}
            <span>{a.workflow_name ?? "Agent task"} · {a.workflow_version ? `v${a.workflow_version}` : "draft test run"}</span><span>{ago(a.created_at)}</span>
            <Link href={`/app/executions/${a.execution_id}`} className="text-accent hover:underline">View run</Link></p>
        </div>
        <div className="flex items-center gap-2">
          {a.amount != null && <span className="text-lg font-semibold tabular-nums">{a.amount.toLocaleString(undefined, { style: "currency", currency: a.currency || "EUR" })}</span>}
          <StatusBadge status={a.status} /></div>
      </div>
      <div className="grid gap-5 p-5 lg:grid-cols-[1.4fr_1fr]">
        <div className="space-y-3">
          <p className="text-xs font-medium uppercase tracking-wide text-text-3">Proposed action · {action}</p>
          <Payload a={a} />
          <p className="text-xs text-text-3">Your approval covers exactly this content. If anything changes, a fresh approval is required.</p>
        </div>
        <div className="space-y-4 text-sm">
          {a.reason && <div><p className="font-medium">Reason</p><p className="whitespace-pre-wrap text-text-2">{a.reason}</p></div>}
          {a.risks && <div><p className="font-medium">Risks</p><p className="text-text-2">{a.risks}</p></div>}
          {a.evidence.length > 0 && <div><p className="font-medium">Evidence</p><ul className="mt-1 space-y-1 text-text-2">{a.evidence.map((e, i) => (
            <li key={i} className="flex gap-1.5">{"pricing_violations" in e ? <><MessageSquareWarning className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />{(e.pricing_violations as string[]).join("; ")}</>
              : <><FileText className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />{String(e.document)} · chunk {String(e.chunk)}</>}</li>))}</ul></div>}
          {a.expires_at && a.status === "pending" && <p className={`flex items-center gap-1 text-xs ${expiresSoon ? "text-warning" : "text-text-3"}`}><Clock className="h-3.5 w-3.5" aria-hidden />Expires {dt(a.expires_at)}</p>}
          {a.comment && <Alert title="Comment">{a.comment}</Alert>}
        </div>
      </div>
      {a.status === "pending" && (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3">
          {!a.can_decide && <span className="mr-auto text-xs text-text-3">Requires the {a.approver_role} role or higher.</span>}
          <Button variant="ghost" disabled={!a.can_decide} onClick={() => setMode("request_changes")}>Request changes</Button>
          <Button variant="secondary" disabled={!a.can_decide} onClick={() => setMode("reject")}><X className="h-4 w-4" aria-hidden />Reject</Button>
          <Button disabled={!a.can_decide} loading={decide.isPending && !mode} onClick={() => decide.mutate({ decision: "approve" })}><Check className="h-4 w-4" aria-hidden />Approve</Button>
        </div>
      )}
      <Dialog open={!!mode} onOpenChange={() => setMode(null)} title={mode === "reject" ? "Reject this action" : "Request changes"} description="The workflow stops and your comment is recorded in the audit log."
        footer={<><Button variant="ghost" onClick={() => setMode(null)}>Cancel</Button><Button variant={mode === "reject" ? "danger" : "primary"} disabled={!comment.trim()} loading={decide.isPending} onClick={() => decide.mutate({ decision: mode!, comment })}>Confirm</Button></>}>
        <Textarea aria-label="Comment" rows={4} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="What should change?" />
      </Dialog>
    </Card>
  );
}

export default function Approvals() {
  const [tab, setTab] = useState<"pending" | "all" | "failures" | "reviews">("pending");
  const approvals = useList<Approval[]>(["approvals", tab], `/approvals?status=${tab === "pending" ? "pending" : "all"}`, { refetchInterval: 10_000, enabled: tab === "pending" || tab === "all" });
  const failed = useList<Execution[]>(["executions", "failed"], "/executions?status=failed", { enabled: tab === "failures" });
  const reviews = useList<Task[]>(["tasks", "review"], "/tasks?status=Awaiting%20Approval", { enabled: tab === "reviews" });
  const review = useAction((v: { id: string; decision: string }) => post(`/tasks/${v.id}/review`, { decision: v.decision }), { success: "Recorded", invalidate: [["tasks"]] });
  return (
    <>
      <PageHeader title="Inbox & Approvals" description="Actions waiting for a human decision, task results to review, and runs that need attention." />
      <div className="mb-5"><Tabs value={tab} onChange={setTab} items={[{ value: "pending", label: "Pending approvals" }, { value: "reviews", label: "Task reviews" }, { value: "failures", label: "Failures" }, { value: "all", label: "History" }]} /></div>
      {(tab === "pending" || tab === "all") && (approvals.isLoading ? <Loading /> : !approvals.data?.length
        ? <EmptyState icon={<Check className="h-8 w-8" />} title={tab === "pending" ? "You're all caught up" : "No approvals yet"} description="When an agent prepares an external action, it waits here for your decision." />
        : <div className="space-y-4">{approvals.data.map((a) => <Card_ key={a.id} a={a} />)}</div>)}
      {tab === "reviews" && (reviews.isLoading ? <Loading /> : !reviews.data?.length ? <EmptyState title="No task results to review" /> : (
        <div className="space-y-3">{reviews.data.map((t) => (
          <Card key={t.id} className="p-5"><div className="flex items-start justify-between gap-4"><div><h3 className="font-medium">{t.title}</h3><p className="text-xs text-text-3">{t.agent_name} · {ago(t.created_at)}</p></div>
            <div className="flex gap-2"><Button size="sm" variant="secondary" onClick={() => review.mutate({ id: t.id, decision: "reject" })}>Reject</Button><Button size="sm" onClick={() => review.mutate({ id: t.id, decision: "accept" })}>Accept result</Button></div></div>
            <div className="mt-3"><Code>{JSON.stringify(t.result, null, 2)}</Code></div></Card>))}</div>))}
      {tab === "failures" && (failed.isLoading ? <Loading /> : !failed.data?.length ? <EmptyState title="No failed runs" /> : (
        <div className="space-y-2">{failed.data.map((e) => (
          <Link key={e.id} href={`/app/executions/${e.id}`}><Card className="flex items-center justify-between gap-4 p-4 hover:border-accent/50">
            <div className="min-w-0"><p className="font-medium">{e.workflow_name ?? "Agent task"}</p><p className="truncate text-sm text-critical">{e.error}</p></div>
            <span className="shrink-0 text-xs text-text-3">{ago(e.created_at)}</span></Card></Link>))}<Badge className="mt-2">Showing the latest 50</Badge></div>))}
    </>
  );
}
