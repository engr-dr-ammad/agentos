import csv
import io
from datetime import UTC, date, datetime, timedelta
from uuid import UUID

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from sqlalchemy import String, case, cast, func, select

from ..deps import Viewer
from ..llm.service import month_start
from ..models import Agent, Approval, NodeExecution, Organization, UsageEvent, Workflow, WorkflowExecution

router = APIRouter(prefix="/analytics", tags=["analytics"])


def _range(days: int, start: date | None, end: date | None) -> tuple[datetime, datetime]:
    e = datetime.combine(end, datetime.max.time(), UTC) if end else datetime.now(UTC)
    s = datetime.combine(start, datetime.min.time(), UTC) if start else e - timedelta(days=days)
    return s, e


@router.get("/overview")
async def overview(ctx: Viewer):
    db, org = ctx.db, ctx.org_id
    WE = WorkflowExecution
    since = datetime.now(UTC) - timedelta(days=30)
    status_counts = dict((await db.execute(select(WE.status, func.count()).where(
        WE.org_id == org, WE.created_at >= since).group_by(WE.status))).all())
    active_agents = await db.scalar(select(func.count()).select_from(Agent).where(Agent.org_id == org,
                                                                                  Agent.status == "active"))
    total_agents = await db.scalar(select(func.count()).select_from(Agent).where(Agent.org_id == org))
    pending = await db.scalar(select(func.count()).select_from(Approval).where(Approval.org_id == org,
                                                                               Approval.status == "pending"))
    spend_month = await db.scalar(select(func.coalesce(func.sum(UsageEvent.cost_usd), 0)).where(
        UsageEvent.org_id == org, UsageEvent.created_at >= month_start()))
    org_row = await db.get(Organization, org)
    recent = (await db.execute(select(WE, Workflow.name).outerjoin(Workflow, Workflow.id == WE.workflow_id)
                               .where(WE.org_id == org).order_by(WE.created_at.desc()).limit(8))).all()
    return {
        "active_agents": active_agents, "total_agents": total_agents,
        "running": sum(status_counts.get(s, 0) for s in ("queued", "running", "waiting", "awaiting_approval")),
        "completed_30d": status_counts.get("completed", 0), "failed_30d": status_counts.get("failed", 0),
        "pending_approvals": pending, "spend_month_usd": float(spend_month),
        "budget_month_usd": float(org_row.monthly_budget_usd) if org_row.monthly_budget_usd is not None else None,
        "recent": [{"id": e.id, "workflow": n or "Agent task", "status": e.status, "mode": e.mode,
                    "created_at": e.created_at, "cost_usd": float(e.cost_usd or 0)} for e, n in recent],
    }


@router.get("/usage")
async def usage(ctx: Viewer, days: int = 30, start: date | None = None, end: date | None = None,
                agent_id: UUID | None = None, workflow_id: UUID | None = None):
    s, e = _range(days, start, end)
    U = UsageEvent
    flt = [U.org_id == ctx.org_id, U.created_at >= s, U.created_at <= e]
    if agent_id:
        flt.append(U.agent_id == agent_id)
    if workflow_id:
        flt.append(U.workflow_id == workflow_id)
    day = func.date(func.timezone("UTC", U.created_at)).label("day")  # calendar day in UTC
    series = (await ctx.db.execute(select(
        day, func.coalesce(func.sum(U.cost_usd), 0), func.sum(U.tokens_in), func.sum(U.tokens_out),
        func.sum(case((U.kind == "execution", 1), else_=0))).where(*flt).group_by(day).order_by(day))).all()
    by_agent = (await ctx.db.execute(select(Agent.name, func.coalesce(func.sum(U.cost_usd), 0), func.count())
                                     .join(Agent, Agent.id == U.agent_id).where(*flt).group_by(Agent.name)
                                     .order_by(func.sum(U.cost_usd).desc()))).all()
    by_model = (await ctx.db.execute(select(U.model, func.coalesce(func.sum(U.cost_usd), 0),
                                            func.sum(U.tokens_in + U.tokens_out))
                                     .where(*flt, U.kind == "llm").group_by(U.model))).all()
    return {
        "from": s, "to": e,
        "series": [{"day": d.isoformat(), "cost_usd": float(c), "tokens_in": int(ti or 0),
                    "tokens_out": int(to or 0), "executions": int(n or 0)} for d, c, ti, to, n in series],
        "by_agent": [{"agent": n, "cost_usd": float(c), "calls": k} for n, c, k in by_agent],
        "by_model": [{"model": m, "cost_usd": float(c), "tokens": int(t or 0)} for m, c, t in by_model],
        "totals": {"cost_usd": sum(float(r[1]) for r in series),
                   "tokens": sum(int((r[2] or 0) + (r[3] or 0)) for r in series),
                   "executions": sum(int(r[4] or 0) for r in series)},
        "note": "Costs are calculated from token counts reported by each provider and the prices you entered.",
    }


@router.get("/agents")
async def agent_performance(ctx: Viewer, days: int = 30):
    s, _ = _range(days, None, None)
    NE = NodeExecution
    rows = (await ctx.db.execute(select(
        Agent.id, Agent.name, Agent.department, func.count(NE.id),
        func.sum(case((NE.status == "completed", 1), else_=0)),
        func.sum(case((NE.status.in_(["failed", "failed_continued"]), 1), else_=0)),
        func.avg(func.extract("epoch", NE.finished_at - NE.started_at)),
        func.coalesce(func.sum(NE.cost_usd), 0), func.sum(NE.tokens_in + NE.tokens_out))
        .outerjoin(NE, (NE.input["agent_id"].astext == cast(Agent.id, String))
                   & (NE.started_at >= s) & (NE.node_type == "agent"))
        .where(Agent.org_id == ctx.org_id).group_by(Agent.id, Agent.name, Agent.department))).all()
    approvals = dict((await ctx.db.execute(select(Approval.requested_by_agent, func.count()).where(
        Approval.org_id == ctx.org_id, Approval.created_at >= s).group_by(Approval.requested_by_agent))).all())
    rejected = dict((await ctx.db.execute(select(Approval.requested_by_agent, func.count()).where(
        Approval.org_id == ctx.org_id, Approval.created_at >= s,
        Approval.status.in_(["rejected", "changes_requested"])).group_by(Approval.requested_by_agent))).all())
    out = []
    for aid, name, dept, att, ok, fail, avg, cost, tokens in rows:
        att = int(att or 0)
        out.append({"agent_id": aid, "agent": name, "department": dept, "attempted": att,
                    "completed": int(ok or 0), "failed": int(fail or 0),
                    "success_rate": round(int(ok or 0) / att, 3) if att else None,
                    "error_rate": round(int(fail or 0) / att, 3) if att else None,
                    "avg_seconds": round(float(avg), 2) if avg else None, "cost_usd": float(cost),
                    "avg_cost_usd": round(float(cost) / att, 6) if att else None, "tokens": int(tokens or 0),
                    "approval_requests": approvals.get(name, 0), "human_corrections": rejected.get(name, 0)})
    return out


@router.get("/export.csv")
async def export_csv(ctx: Viewer, days: int = 30):
    s, _ = _range(days, None, None)
    rows = (await ctx.db.execute(select(WorkflowExecution, Workflow.name)
                                 .outerjoin(Workflow, Workflow.id == WorkflowExecution.workflow_id)
                                 .where(WorkflowExecution.org_id == ctx.org_id, WorkflowExecution.created_at >= s)
                                 .order_by(WorkflowExecution.created_at))).all()
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["execution_id", "workflow", "version", "mode", "status", "trigger", "created_at", "finished_at",
                "duration_seconds", "cost_usd", "error"])
    for e, n in rows:
        dur = (e.finished_at - e.started_at).total_seconds() if e.finished_at and e.started_at else ""
        w.writerow([e.id, n or "agent task", e.version, e.mode, e.status, e.trigger_type, e.created_at.isoformat(),
                    e.finished_at.isoformat() if e.finished_at else "", dur, f"{e.cost_usd:.6f}",
                    (e.error or "").replace("\n", " ")])
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": f'attachment; filename="agentos-executions-{days}d.csv"'})
