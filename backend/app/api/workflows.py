import copy
import hmac
import json
from datetime import UTC, datetime
from typing import Any, Literal
from uuid import UUID

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import SessionLocal, tenant_session
from ..deps import Employee, Manager, Viewer, audit, get_or_404
from ..engine.catalog import NODE_TYPES
from ..engine.executor import enqueue
from ..engine.validator import blocking, load_lookup, validate
from ..engine.worker import next_run
from ..llm.service import month_start
from ..models import (
    Agent,
    Approval,
    NodeExecution,
    Organization,
    Schedule,
    WebhookEndpoint,
    Workflow,
    WorkflowExecution,
    WorkflowVersion,
)
from ..plans import limit as plan_limit
from ..security import decrypt, encrypt, new_token, sha256

router = APIRouter(tags=["workflows"])


class Definition(BaseModel):
    nodes: list[dict[str, Any]] = Field(default_factory=list, max_length=200)
    edges: list[dict[str, Any]] = Field(default_factory=list, max_length=600)


class WorkflowIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    description: str = ""
    draft: Definition = Definition()


class WorkflowPatch(BaseModel):
    name: str | None = Field(None, max_length=160)
    description: str | None = None
    draft: Definition | None = None
    monthly_budget_usd: float | None = Field(None, ge=0)


@router.get("/node-types")
async def node_types(ctx: Viewer):
    return NODE_TYPES


def wf_out(w: Workflow, detail: bool = False) -> dict:
    out = {"id": w.id, "name": w.name, "description": w.description, "status": w.status,
           "published_version": w.published_version, "monthly_budget_usd": w.monthly_budget_usd,
           "created_at": w.created_at, "updated_at": w.updated_at,
           "node_count": len((w.draft or {}).get("nodes", []))}
    if detail:
        out["draft"] = w.draft
    return out


@router.get("/workflows")
async def list_workflows(ctx: Viewer):
    rows = (await ctx.db.scalars(select(Workflow).where(Workflow.org_id == ctx.org_id)
                                 .order_by(Workflow.updated_at.desc()))).all()
    last = dict((await ctx.db.execute(
        select(WorkflowExecution.workflow_id, func.max(WorkflowExecution.created_at))
        .where(WorkflowExecution.org_id == ctx.org_id).group_by(WorkflowExecution.workflow_id))).all())
    return [wf_out(w) | {"last_run_at": last.get(w.id)} for w in rows]


@router.post("/workflows", status_code=201)
async def create_workflow(body: WorkflowIn, ctx: Manager):
    org = await ctx.db.get(Organization, ctx.org_id)
    cap = plan_limit(org.plan, "workflows")
    n = await ctx.db.scalar(select(func.count()).select_from(Workflow).where(Workflow.org_id == ctx.org_id))
    if cap is not None and n >= cap:
        raise HTTPException(402, f"Your {org.plan} plan allows {cap} workflows. Upgrade under Billing.")
    w = Workflow(org_id=ctx.org_id, name=body.name, description=body.description,
                 draft=body.draft.model_dump(), created_by=ctx.user.id)
    ctx.db.add(w)
    await ctx.db.flush()
    await ctx.audit("workflow.created", "workflow", w.id, name=w.name)
    await ctx.db.commit()
    return wf_out(w, True)


@router.get("/workflows/{wid}")
async def get_workflow(wid: UUID, ctx: Viewer):
    w = await get_or_404(ctx.db, Workflow, wid, ctx.org_id, "Workflow")
    hook = await ctx.db.scalar(select(WebhookEndpoint).where(WebhookEndpoint.workflow_id == wid))
    return wf_out(w, True) | {"has_webhook": hook is not None}


@router.patch("/workflows/{wid}")
async def update_workflow(wid: UUID, body: WorkflowPatch, ctx: Manager):
    w = await get_or_404(ctx.db, Workflow, wid, ctx.org_id, "Workflow")
    data = body.model_dump(exclude_unset=True)
    if "draft" in data:
        w.draft = data.pop("draft")  # draft edits never affect published versions
    for k, v in data.items():
        setattr(w, k, v)
    w.updated_at = datetime.now(UTC)
    await ctx.db.commit()
    return wf_out(w, True)


@router.delete("/workflows/{wid}")
async def delete_workflow(wid: UUID, ctx: Manager):
    w = await get_or_404(ctx.db, Workflow, wid, ctx.org_id, "Workflow")
    running = await ctx.db.scalar(select(func.count()).select_from(WorkflowExecution).where(
        WorkflowExecution.workflow_id == wid,
        WorkflowExecution.status.in_(["queued", "running", "awaiting_approval", "waiting"])))
    if running:
        raise HTTPException(409, "This workflow has executions in progress. Cancel them first.")
    await ctx.db.delete(w)
    await ctx.audit("workflow.deleted", "workflow", wid, name=w.name)
    await ctx.db.commit()
    return {"ok": True}


@router.post("/workflows/{wid}/validate")
async def validate_workflow(wid: UUID, ctx: Viewer, body: Definition | None = None):
    w = await get_or_404(ctx.db, Workflow, wid, ctx.org_id, "Workflow")
    defn = body.model_dump() if body else w.draft
    issues = validate(defn, await load_lookup(ctx.db, ctx.org_id, wid))
    return {"valid": not blocking(issues), "issues": issues}


class PublishIn(BaseModel):
    note: str | None = Field(None, max_length=300)
    activate: bool = True


async def _pin_agents(db: AsyncSession, org_id: UUID, defn: dict) -> dict:
    """Freeze the exact agent versions used by a published workflow."""
    defn = copy.deepcopy(defn)
    for n in defn.get("nodes", []):
        if n.get("type") == "agent":
            cfg = n.setdefault("data", {}).setdefault("config", {})
            a = await db.get(Agent, UUID(str(cfg["agent_id"])))
            if a and a.org_id == org_id:
                cfg["agent_version"] = a.current_version
    return defn


@router.post("/workflows/{wid}/publish")
async def publish(wid: UUID, body: PublishIn, ctx: Manager):
    w = await get_or_404(ctx.db, Workflow, wid, ctx.org_id, "Workflow")
    issues = validate(w.draft, await load_lookup(ctx.db, ctx.org_id, wid))
    if blocking(issues):
        raise HTTPException(422, {"message": "Fix the highlighted problems before publishing", "issues": issues})
    version = (w.published_version or 0) + 1
    latest = await ctx.db.scalar(select(func.max(WorkflowVersion.version)).where(WorkflowVersion.workflow_id == wid))
    version = max(version, (latest or 0) + 1)
    defn = await _pin_agents(ctx.db, ctx.org_id, w.draft)
    ctx.db.add(WorkflowVersion(org_id=ctx.org_id, workflow_id=wid, version=version, definition=defn,
                               note=body.note, created_by=ctx.user.id))
    w.published_version = version
    if body.activate:
        w.status = "active"
    secret = await _sync_triggers(ctx.db, w, defn)
    await ctx.audit("workflow.published", "workflow", wid, version=version)
    await ctx.db.commit()
    return {"version": version, "status": w.status, "issues": issues, **({"webhook": secret} if secret else {})}


async def _sync_triggers(db: AsyncSession, w: Workflow, defn: dict) -> dict | None:
    trigger = next((n for n in defn["nodes"] if n["type"].startswith("trigger.")), None)
    cfg = (trigger or {}).get("data", {}).get("config", {}) or {}
    sched = await db.scalar(select(Schedule).where(Schedule.workflow_id == w.id))
    if trigger and trigger["type"] == "trigger.schedule":
        nr = next_run(cfg["cron"], cfg.get("timezone") or "UTC")
        if sched:
            sched.cron, sched.timezone, sched.next_run_at = cfg["cron"], cfg.get("timezone") or "UTC", nr
            sched.enabled = w.status == "active"
        else:
            db.add(Schedule(org_id=w.org_id, workflow_id=w.id, cron=cfg["cron"], timezone=cfg.get("timezone") or "UTC",
                            next_run_at=nr, enabled=w.status == "active"))
    elif sched:
        await db.delete(sched)
    if trigger and trigger["type"] == "trigger.webhook":
        hook = await db.scalar(select(WebhookEndpoint).where(WebhookEndpoint.workflow_id == w.id))
        if hook is None:
            token, secret = new_token(24), new_token(32)
            db.add(WebhookEndpoint(org_id=w.org_id, workflow_id=w.id, token_hash=sha256(token),
                                   secret_enc=encrypt(secret)))
            return {"url_path": f"/api/v1/hooks/{token}", "signing_secret": secret,
                    "note": "Shown once. Sign the raw body with HMAC-SHA256 and send it as X-AgentOS-Signature."}
    return None


@router.post("/workflows/{wid}/webhook/rotate")
async def rotate_webhook(wid: UUID, ctx: Manager):
    w = await get_or_404(ctx.db, Workflow, wid, ctx.org_id, "Workflow")
    await ctx.db.execute(delete(WebhookEndpoint).where(WebhookEndpoint.workflow_id == w.id))
    token, secret = new_token(24), new_token(32)
    ctx.db.add(WebhookEndpoint(org_id=ctx.org_id, workflow_id=w.id, token_hash=sha256(token),
                               secret_enc=encrypt(secret)))
    await ctx.audit("workflow.webhook_rotated", "workflow", wid)
    await ctx.db.commit()
    return {"url_path": f"/api/v1/hooks/{token}", "signing_secret": secret}


class StatusIn(BaseModel):
    status: Literal["active", "paused"]


@router.post("/workflows/{wid}/status")
async def set_status(wid: UUID, body: StatusIn, ctx: Manager):
    w = await get_or_404(ctx.db, Workflow, wid, ctx.org_id, "Workflow")
    if body.status == "active" and not w.published_version:
        raise HTTPException(400, "Publish the workflow before activating it")
    w.status = body.status
    sched = await ctx.db.scalar(select(Schedule).where(Schedule.workflow_id == wid))
    if sched:
        sched.enabled = body.status == "active"
    await ctx.audit(f"workflow.{body.status}", "workflow", wid)
    await ctx.db.commit()
    return {"ok": True, "status": w.status}


@router.get("/workflows/{wid}/versions")
async def versions(wid: UUID, ctx: Viewer):
    await get_or_404(ctx.db, Workflow, wid, ctx.org_id, "Workflow")
    rows = (await ctx.db.scalars(select(WorkflowVersion).where(WorkflowVersion.workflow_id == wid)
                                 .order_by(WorkflowVersion.version.desc()))).all()
    return [{"version": v.version, "note": v.note, "created_at": v.created_at, "created_by": v.created_by,
             "node_count": len(v.definition.get("nodes", []))} for v in rows]


@router.get("/workflows/{wid}/versions/{version}")
async def get_version(wid: UUID, version: int, ctx: Viewer):
    v = await ctx.db.scalar(select(WorkflowVersion).where(WorkflowVersion.workflow_id == wid,
                                                          WorkflowVersion.version == version,
                                                          WorkflowVersion.org_id == ctx.org_id))
    if not v:
        raise HTTPException(404, "Version not found")
    return {"version": v.version, "definition": v.definition, "note": v.note, "created_at": v.created_at}


def diff(a: dict, b: dict) -> dict:
    an, bn = {n["id"]: n for n in a.get("nodes", [])}, {n["id"]: n for n in b.get("nodes", [])}
    strip = lambda n: {"type": n.get("type"), "label": n.get("data", {}).get("label"),  # noqa: E731
                       "config": {k: v for k, v in (n.get("data", {}).get("config") or {}).items()
                                  if k != "agent_version"}}
    ae = {(e["source"], e["target"], e.get("sourceHandle")) for e in a.get("edges", [])}
    be = {(e["source"], e["target"], e.get("sourceHandle")) for e in b.get("edges", [])}
    return {
        "added_nodes": [bn[i].get("data", {}).get("label") or i for i in bn.keys() - an.keys()],
        "removed_nodes": [an[i].get("data", {}).get("label") or i for i in an.keys() - bn.keys()],
        "changed_nodes": [{"node": bn[i].get("data", {}).get("label") or i,
                           "fields": sorted(k for k in set(strip(an[i])["config"]) | set(strip(bn[i])["config"])
                                            if strip(an[i])["config"].get(k) != strip(bn[i])["config"].get(k))
                           + (["label"] if strip(an[i])["label"] != strip(bn[i])["label"] else [])}
                          for i in an.keys() & bn.keys() if strip(an[i]) != strip(bn[i])],
        "added_connections": len(be - ae), "removed_connections": len(ae - be),
    }


@router.get("/workflows/{wid}/diff")
async def compare(wid: UUID, ctx: Viewer, base: int, target: int | None = None):
    w = await get_or_404(ctx.db, Workflow, wid, ctx.org_id, "Workflow")
    get = lambda v: ctx.db.scalar(select(WorkflowVersion.definition).where(  # noqa: E731
        WorkflowVersion.workflow_id == wid, WorkflowVersion.version == v))
    a = await get(base)
    b = await get(target) if target else w.draft
    if a is None or b is None:
        raise HTTPException(404, "Version not found")
    return diff(a, b)


@router.post("/workflows/{wid}/versions/{version}/restore")
async def restore(wid: UUID, version: int, ctx: Manager):
    """Rollback: copy a published version into the draft (publish again to make it live)."""
    w = await get_or_404(ctx.db, Workflow, wid, ctx.org_id, "Workflow")
    d = await ctx.db.scalar(select(WorkflowVersion.definition).where(
        WorkflowVersion.workflow_id == wid, WorkflowVersion.version == version))
    if d is None:
        raise HTTPException(404, "Version not found")
    w.draft = d
    await ctx.audit("workflow.restored", "workflow", wid, version=version)
    await ctx.db.commit()
    return wf_out(w, True)


@router.post("/workflows/{wid}/clone", status_code=201)
async def clone(wid: UUID, ctx: Manager):
    w = await get_or_404(ctx.db, Workflow, wid, ctx.org_id, "Workflow")
    return await create_workflow(WorkflowIn(name=f"{w.name} (copy)"[:160], description=w.description,
                                            draft=Definition(**w.draft)), ctx)


@router.get("/workflows/{wid}/export")
async def export(wid: UUID, ctx: Viewer):
    w = await get_or_404(ctx.db, Workflow, wid, ctx.org_id, "Workflow")
    return {"format": "agentos.workflow/v1", "name": w.name, "description": w.description, "definition": w.draft}


class ImportIn(BaseModel):
    format: Literal["agentos.workflow/v1"]
    name: str
    description: str = ""
    definition: Definition


@router.post("/workflows/import", status_code=201)
async def import_workflow(body: ImportIn, ctx: Manager):
    # Imported references (agents, connections) are validated on publish; nothing runs on import.
    return await create_workflow(WorkflowIn(name=body.name, description=body.description, draft=body.definition), ctx)


# ================================================================== executions
async def start_execution(db: AsyncSession, org_id: UUID, wf: Workflow | None, *, input: dict,
                          trigger_type: str = "manual", mode: str = "production", user_id: UUID | None = None,
                          task_id: UUID | None = None, definition: dict | None = None) -> WorkflowExecution:
    org = await db.get(Organization, org_id)
    cap = plan_limit(org.plan, "executions_per_month")
    if cap is not None:
        n = await db.scalar(select(func.count()).select_from(WorkflowExecution).where(
            WorkflowExecution.org_id == org_id, WorkflowExecution.created_at >= month_start()))
        if n >= cap:
            raise HTTPException(402, f"Monthly execution limit ({cap}) reached for the {org.plan} plan")
    if mode == "production" and definition is None:
        if wf is None or wf.status != "active" or not wf.published_version:
            raise HTTPException(409, "This workflow is not active. Publish and activate it first.")
    ex = WorkflowExecution(org_id=org_id, workflow_id=wf.id if wf else None,
                           version=wf.published_version if (wf and definition is None) else 0,
                           definition=definition, mode=mode, trigger_type=trigger_type, input=input,
                           created_by=user_id, task_id=task_id, status="queued")
    db.add(ex)
    await db.flush()
    await enqueue(db, ex)
    await audit(db, org_id, "execution.started", "execution", ex.id,
                {"workflow_id": str(ex.workflow_id) if ex.workflow_id else None, "mode": mode,
                 "trigger": trigger_type}, actor_type="user" if user_id else "system",
                actor_id=str(user_id) if user_id else None)
    return ex


class RunIn(BaseModel):
    input: dict[str, Any] = {}
    mode: Literal["test", "production"] = "production"


@router.post("/workflows/{wid}/run", status_code=202)
async def run(wid: UUID, body: RunIn, ctx: Employee):
    w = await get_or_404(ctx.db, Workflow, wid, ctx.org_id, "Workflow")
    definition = None
    if body.mode == "test":
        issues = validate(w.draft, await load_lookup(ctx.db, ctx.org_id, wid))
        if blocking(issues):
            raise HTTPException(422, {"message": "Fix the highlighted problems before testing", "issues": issues})
        definition = copy.deepcopy(w.draft)
    ex = await start_execution(ctx.db, ctx.org_id, w, input=body.input, mode=body.mode, user_id=ctx.user.id,
                               definition=definition)
    await ctx.db.commit()
    return {"execution_id": ex.id, "status": ex.status, "mode": ex.mode}


def ex_out(e: WorkflowExecution, wf_name: str | None = None) -> dict:
    return {"id": e.id, "workflow_id": e.workflow_id, "workflow_name": wf_name, "version": e.version,
            "mode": e.mode, "status": e.status, "trigger_type": e.trigger_type, "error": e.error,
            "cost_usd": float(e.cost_usd or 0), "created_at": e.created_at, "started_at": e.started_at,
            "finished_at": e.finished_at, "task_id": e.task_id}


@router.get("/executions")
async def list_executions(ctx: Viewer, workflow_id: UUID | None = None, status: str | None = None, limit: int = 50):
    q = (select(WorkflowExecution, Workflow.name).outerjoin(Workflow, Workflow.id == WorkflowExecution.workflow_id)
         .where(WorkflowExecution.org_id == ctx.org_id))
    if workflow_id:
        q = q.where(WorkflowExecution.workflow_id == workflow_id)
    if status:
        q = q.where(WorkflowExecution.status == status)
    rows = (await ctx.db.execute(q.order_by(WorkflowExecution.created_at.desc()).limit(min(limit, 200)))).all()
    return [ex_out(e, n) for e, n in rows]


REDACT_ROLES = {"viewer"}


@router.get("/executions/{eid}")
async def get_execution(eid: UUID, ctx: Viewer):
    e = await get_or_404(ctx.db, WorkflowExecution, eid, ctx.org_id, "Execution")
    defn = e.definition
    if defn is None:
        defn = await ctx.db.scalar(select(WorkflowVersion.definition).where(
            WorkflowVersion.workflow_id == e.workflow_id, WorkflowVersion.version == e.version))
    nodes = (await ctx.db.scalars(select(NodeExecution).where(NodeExecution.execution_id == eid)
                                  .order_by(NodeExecution.started_at.nulls_last()))).all()
    redact = ctx.role in REDACT_ROLES
    approvals = (await ctx.db.scalars(select(Approval).where(Approval.execution_id == eid))).all()
    wf_name = await ctx.db.scalar(select(Workflow.name).where(Workflow.id == e.workflow_id)) if e.workflow_id else None
    return {**ex_out(e, wf_name), "input": None if redact else e.input, "output": None if redact else e.output,
            "definition": defn,
            "nodes": [{"node_id": n.node_id, "type": n.node_type, "status": n.status, "attempt": n.attempt,
                       "output": None if redact else n.output, "error": n.error, "cost_usd": float(n.cost_usd),
                       "tokens_in": n.tokens_in, "tokens_out": n.tokens_out, "started_at": n.started_at,
                       "finished_at": n.finished_at,
                       "duration_ms": int((n.finished_at - n.started_at).total_seconds() * 1000)
                       if n.finished_at and n.started_at else None} for n in nodes],
            "approvals": [{"id": a.id, "node_id": a.node_id, "status": a.status} for a in approvals],
            "redacted": redact}


@router.post("/executions/{eid}/cancel")
async def cancel(eid: UUID, ctx: Employee):
    e = await get_or_404(ctx.db, WorkflowExecution, eid, ctx.org_id, "Execution")
    if e.status in ("completed", "failed", "cancelled", "rejected"):
        raise HTTPException(409, "Execution already finished")
    e.cancel_requested = True
    await enqueue(ctx.db, e)  # wake parked executions so cancellation is applied promptly
    await ctx.audit("execution.cancel_requested", "execution", eid)
    await ctx.db.commit()
    return {"ok": True}


# ================================================================== public webhook
hooks = APIRouter(tags=["webhooks"])


@hooks.post("/hooks/{token}", status_code=202)
async def webhook(token: str, request: Request):
    raw = await request.body()
    if len(raw) > 1_000_000:
        raise HTTPException(413, "Payload too large")
    async with SessionLocal() as db:
        hook = await db.scalar(select(WebhookEndpoint).where(WebhookEndpoint.token_hash == sha256(token)))
        if hook is None:
            raise HTTPException(404, "Unknown webhook")
        expected = hmac.new(decrypt(hook.secret_enc).encode(), raw, "sha256").hexdigest()
        sig = request.headers.get("x-agentos-signature", "").removeprefix("sha256=")
        if not hmac.compare_digest(expected, sig):
            raise HTTPException(401, "Invalid signature")
        org_id, wf_id = hook.org_id, hook.workflow_id
    try:
        payload = json.loads(raw or b"{}")
    except ValueError as e:
        raise HTTPException(400, "Body must be JSON") from e
    if not isinstance(payload, dict):
        payload = {"data": payload}
    idem = request.headers.get("idempotency-key")
    async with tenant_session(org_id) as db:
        wf = await db.get(Workflow, wf_id)
        if idem:
            dup = await db.scalar(select(WorkflowExecution.id).where(
                WorkflowExecution.workflow_id == wf_id, WorkflowExecution.input["_idempotency_key"].astext == idem))
            if dup:
                return {"execution_id": dup, "deduplicated": True}
            payload["_idempotency_key"] = idem
        ex = await start_execution(db, org_id, wf, input=payload, trigger_type="webhook")
        await db.commit()
        return {"execution_id": ex.id}
