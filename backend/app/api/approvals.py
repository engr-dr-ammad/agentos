from datetime import UTC, datetime
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from ..deps import Employee, Viewer, get_or_404
from ..engine.executor import enqueue
from ..models import Approval, Membership, User, Workflow, WorkflowExecution
from ..security import ROLE_RANK

router = APIRouter(tags=["approvals"])


def approval_out(a: Approval, wf_name: str | None = None) -> dict:
    return {"id": a.id, "title": a.title, "reason": a.reason, "risks": a.risks, "payload": a.payload,
            "payload_hash": a.payload_hash, "amount": float(a.amount) if a.amount is not None else None,
            "currency": a.currency, "evidence": a.evidence, "approver_role": a.approver_role,
            "requested_by_agent": a.requested_by_agent, "status": a.status, "decided_by": a.decided_by,
            "decided_at": a.decided_at, "comment": a.comment, "expires_at": a.expires_at,
            "created_at": a.created_at, "execution_id": a.execution_id, "workflow_id": a.workflow_id,
            "workflow_name": wf_name, "workflow_version": a.workflow_version, "delegated_to": a.delegated_to}


@router.get("/approvals")
async def list_approvals(ctx: Viewer, status: str | None = "pending", limit: int = 100):
    q = (select(Approval, Workflow.name).outerjoin(Workflow, Workflow.id == Approval.workflow_id)
         .where(Approval.org_id == ctx.org_id))
    if status and status != "all":
        q = q.where(Approval.status == status)
    rows = (await ctx.db.execute(q.order_by(Approval.created_at.desc()).limit(min(limit, 500)))).all()
    return [approval_out(a, n) | {"can_decide": _can_decide(ctx, a)} for a, n in rows]


@router.get("/approvals/count")
async def pending_count(ctx: Viewer):
    return {"pending": await ctx.db.scalar(select(func.count()).select_from(Approval).where(
        Approval.org_id == ctx.org_id, Approval.status == "pending"))}


def _can_decide(ctx, a: Approval) -> bool:
    if a.delegated_to:
        return a.delegated_to == ctx.user.id
    return ROLE_RANK[ctx.role] >= ROLE_RANK.get(a.approver_role, 2)


class DecisionIn(BaseModel):
    decision: Literal["approve", "reject", "request_changes"]
    payload_hash: str = Field(min_length=64, max_length=64, description="Hash of the payload you reviewed")
    comment: str | None = Field(None, max_length=4000)


@router.post("/approvals/{aid}/decide")
async def decide(aid: UUID, body: DecisionIn, ctx: Employee):
    a = await get_or_404(ctx.db, Approval, aid, ctx.org_id, "Approval")
    a = await ctx.db.get(Approval, aid, with_for_update=True, populate_existing=True)
    if a.status != "pending":
        raise HTTPException(409, f"This approval is already {a.status}")
    if a.expires_at and a.expires_at < datetime.now(UTC):
        raise HTTPException(409, "This approval has expired")
    if not _can_decide(ctx, a):
        raise HTTPException(403, f"Only a {a.approver_role} or higher (or the delegate) can decide this approval")
    if body.payload_hash != a.payload_hash:
        raise HTTPException(409, "The proposed action changed. Reload and review it again.")
    if body.decision != "approve" and not body.comment:
        raise HTTPException(422, "Please explain what should change")
    ex = await ctx.db.get(WorkflowExecution, a.execution_id)
    # Separation of duties: the person who started a production run cannot approve its actions when
    # another eligible approver exists.
    if body.decision == "approve" and ex.mode == "production" and ex.created_by == ctx.user.id:
        others = await ctx.db.scalar(select(func.count()).select_from(Membership).where(
            Membership.org_id == ctx.org_id, Membership.user_id != ctx.user.id,
            Membership.role.in_([r for r, k in ROLE_RANK.items() if k >= ROLE_RANK.get(a.approver_role, 2)])))
        if others:
            raise HTTPException(403, "Separation of duties: someone else must approve a run you started")
    a.status = {"approve": "approved", "reject": "rejected", "request_changes": "changes_requested"}[body.decision]
    a.decided_by, a.decided_at, a.comment = ctx.user.id, datetime.now(UTC), body.comment
    await enqueue(ctx.db, ex)
    await ctx.audit(f"approval.{a.status}", "approval", aid, execution_id=str(a.execution_id),
                    payload_hash=a.payload_hash)
    await ctx.db.commit()
    return approval_out(a)


class DelegateIn(BaseModel):
    user_id: UUID


@router.post("/approvals/{aid}/delegate")
async def delegate(aid: UUID, body: DelegateIn, ctx: Employee):
    a = await get_or_404(ctx.db, Approval, aid, ctx.org_id, "Approval")
    if a.status != "pending" or not _can_decide(ctx, a):
        raise HTTPException(403, "You cannot delegate this approval")
    m = await ctx.db.scalar(select(Membership).where(Membership.org_id == ctx.org_id,
                                                     Membership.user_id == body.user_id))
    if not m or ROLE_RANK[m.role] < ROLE_RANK["employee"]:
        raise HTTPException(422, "Delegate must be a member with at least the employee role")
    a.delegated_to = body.user_id
    user = await ctx.db.get(User, body.user_id)
    await ctx.audit("approval.delegated", "approval", aid, to=user.email)
    await ctx.db.commit()
    return {"ok": True}
