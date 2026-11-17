from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import delete, func, or_, select

from ..deps import Admin, Manager, Owner, Viewer
from ..models import (
    AIActAssessment,
    AuditEvent,
    CrmRecord,
    DataSubjectRequest,
    Department,
    Invitation,
    Membership,
    Organization,
    SandboxMessage,
    User,
)
from ..plans import limit as plan_limit
from ..security import ROLE_RANK, new_token, sha256
from ..templates_registry import suggest

router = APIRouter(tags=["organisation"])
RoleName = Literal["viewer", "employee", "manager", "admin", "owner"]


class OrgUpdate(BaseModel):
    name: str | None = Field(None, max_length=200)
    industry: str | None = None
    size: str | None = None
    country: str | None = None
    language: str | None = None
    timezone: str | None = None
    objective: str | None = None
    website: str | None = None
    monthly_budget_usd: Decimal | None = Field(None, ge=0)
    retention_days: int | None = Field(None, ge=7, le=3650)
    data_region: str | None = None
    onboarded: bool | None = None


@router.get("/org")
async def get_org(ctx: Viewer):
    org = await ctx.db.get(Organization, ctx.org_id)
    return {**{c: getattr(org, c) for c in OrgUpdate.model_fields}, "id": org.id, "plan": org.plan,
            "role": ctx.role}


@router.patch("/org")
async def update_org(body: OrgUpdate, ctx: Admin):
    org = await ctx.db.get(Organization, ctx.org_id)
    data = body.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(org, k, v)
    await ctx.audit("org.updated", "organization", org.id, fields=list(data))
    await ctx.db.commit()
    return {"ok": True}


class SuggestIn(BaseModel):
    description: str = Field(min_length=3, max_length=4000)
    industry: str | None = None


@router.post("/onboarding/suggest")
async def onboarding_suggest(body: SuggestIn, ctx: Viewer):
    """Suggest agents for a plain-English description. Nothing is created or authorised here."""
    return [{"template_id": t.id, "name": t.name, "description": t.description, "category": t.category,
             "required_integrations": t.required_integrations, "approvals": t.approvals,
             "default_mode": t.default_mode} for t in suggest(body.description, body.industry)]


# ------------------------------------------------------------------ team
@router.get("/team/members")
async def members(ctx: Viewer):
    rows = (await ctx.db.execute(select(User, Membership).join(Membership, Membership.user_id == User.id)
                                 .where(Membership.org_id == ctx.org_id).order_by(User.name))).all()
    return [{"user_id": u.id, "name": u.name, "email": u.email, "role": m.role, "department": m.department,
             "mfa_enabled": u.mfa_enabled, "joined_at": m.created_at} for u, m in rows]


class MemberUpdate(BaseModel):
    role: RoleName | None = None
    department: str | None = None


async def _owners(ctx) -> int:
    return await ctx.db.scalar(select(func.count()).select_from(Membership).where(
        Membership.org_id == ctx.org_id, Membership.role == "owner"))


@router.patch("/team/members/{user_id}")
async def update_member(user_id: UUID, body: MemberUpdate, ctx: Admin):
    m = await ctx.db.scalar(select(Membership).where(Membership.org_id == ctx.org_id, Membership.user_id == user_id))
    if not m:
        raise HTTPException(404, "Member not found")
    if body.role:
        if ROLE_RANK[body.role] > ROLE_RANK[ctx.role] or ROLE_RANK[m.role] > ROLE_RANK[ctx.role]:
            raise HTTPException(403, "You cannot grant or change a role above your own")
        if m.role == "owner" and body.role != "owner" and await _owners(ctx) <= 1:
            raise HTTPException(400, "An organisation needs at least one owner")
        m.role = body.role
    if body.department is not None:
        m.department = body.department or None
    await ctx.audit("member.updated", "user", user_id, **body.model_dump(exclude_unset=True))
    await ctx.db.commit()
    return {"ok": True}


@router.delete("/team/members/{user_id}")
async def remove_member(user_id: UUID, ctx: Admin):
    m = await ctx.db.scalar(select(Membership).where(Membership.org_id == ctx.org_id, Membership.user_id == user_id))
    if not m:
        raise HTTPException(404, "Member not found")
    if ROLE_RANK[m.role] > ROLE_RANK[ctx.role]:
        raise HTTPException(403, "You cannot remove someone with a higher role")
    if m.role == "owner" and await _owners(ctx) <= 1:
        raise HTTPException(400, "An organisation needs at least one owner")
    await ctx.db.delete(m)
    await ctx.audit("member.removed", "user", user_id)
    await ctx.db.commit()
    return {"ok": True}


class InviteIn(BaseModel):
    email: EmailStr
    role: RoleName = "employee"


@router.post("/team/invitations", status_code=201)
async def invite(body: InviteIn, ctx: Admin):
    if ROLE_RANK[body.role] > ROLE_RANK[ctx.role]:
        raise HTTPException(403, "You cannot invite someone with a role above your own")
    org = await ctx.db.get(Organization, ctx.org_id)
    cap = plan_limit(org.plan, "members")
    count = await ctx.db.scalar(select(func.count()).select_from(Membership).where(Membership.org_id == ctx.org_id))
    if cap is not None and count >= cap:
        raise HTTPException(402, f"Your {org.plan} plan allows {cap} members. Upgrade under Billing.")
    token = new_token()
    inv = Invitation(org_id=ctx.org_id, email=body.email.lower(), role=body.role, token_hash=sha256(token),
                     invited_by=ctx.user.id, expires_at=datetime.now(UTC) + timedelta(days=7))
    ctx.db.add(inv)
    await ctx.audit("member.invited", "invitation", None, email=inv.email, role=inv.role)
    await ctx.db.commit()
    from ..config import get_settings

    # No email service is assumed: the admin shares the link (shown once).
    return {"id": inv.id, "invite_url": f"{get_settings().public_url}/invite?token={token}",
            "expires_at": inv.expires_at}


@router.get("/team/invitations")
async def invitations(ctx: Admin):
    rows = (await ctx.db.scalars(select(Invitation).where(Invitation.org_id == ctx.org_id,
                                                          Invitation.accepted_at.is_(None))
                                 .order_by(Invitation.created_at.desc()))).all()
    return [{"id": i.id, "email": i.email, "role": i.role, "expires_at": i.expires_at} for i in rows]


@router.delete("/team/invitations/{inv_id}")
async def revoke_invitation(inv_id: UUID, ctx: Admin):
    await ctx.db.execute(delete(Invitation).where(Invitation.id == inv_id, Invitation.org_id == ctx.org_id))
    await ctx.audit("member.invitation_revoked", "invitation", inv_id)
    await ctx.db.commit()
    return {"ok": True}


@router.get("/departments")
async def departments(ctx: Viewer):
    return [{"id": d.id, "name": d.name} for d in (await ctx.db.scalars(
        select(Department).where(Department.org_id == ctx.org_id).order_by(Department.name))).all()]


class DeptIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)


@router.post("/departments", status_code=201)
async def add_department(body: DeptIn, ctx: Manager):
    if await ctx.db.scalar(select(Department.id).where(Department.org_id == ctx.org_id, Department.name == body.name)):
        raise HTTPException(409, "Department already exists")
    d = Department(org_id=ctx.org_id, name=body.name)
    ctx.db.add(d)
    await ctx.db.commit()
    return {"id": d.id, "name": d.name}


# ------------------------------------------------------------------ audit
@router.get("/audit")
async def audit_log(ctx: Admin, q: str | None = None, before: int | None = None, limit: int = 100):
    stmt = select(AuditEvent).where(AuditEvent.org_id == ctx.org_id)
    if q:
        stmt = stmt.where(or_(AuditEvent.action.ilike(f"%{q}%"), AuditEvent.actor_label.ilike(f"%{q}%")))
    if before:
        stmt = stmt.where(AuditEvent.id < before)
    rows = (await ctx.db.scalars(stmt.order_by(AuditEvent.id.desc()).limit(min(limit, 500)))).all()
    return [{"id": e.id, "at": e.created_at, "actor_type": e.actor_type, "actor": e.actor_label,
             "action": e.action, "resource_type": e.resource_type, "resource_id": e.resource_id, "data": e.data,
             "ip": e.ip} for e in rows]


# ------------------------------------------------------------------ GDPR
class DSRIn(BaseModel):
    kind: Literal["access", "erasure"]
    subject_email: EmailStr


@router.get("/privacy/requests")
async def dsr_list(ctx: Admin):
    rows = (await ctx.db.scalars(select(DataSubjectRequest).where(DataSubjectRequest.org_id == ctx.org_id)
                                 .order_by(DataSubjectRequest.created_at.desc()))).all()
    return [{"id": r.id, "kind": r.kind, "subject_email": r.subject_email, "status": r.status,
             "result": r.result, "created_at": r.created_at, "completed_at": r.completed_at} for r in rows]


@router.post("/privacy/requests", status_code=201)
async def dsr_create(body: DSRIn, ctx: Admin):
    """Locate (access) or erase a data subject's records held in AgentOS-managed stores.

    Covers built-in CRM records and the sandbox outbox. Knowledge documents and connected external
    systems must be reviewed manually; the result lists what was and was not covered.
    """
    email = body.subject_email.lower()
    crm = (await ctx.db.scalars(select(CrmRecord).where(CrmRecord.org_id == ctx.org_id,
                                                        func.lower(CrmRecord.external_key) == email))).all()
    outbox = (await ctx.db.scalars(select(SandboxMessage).where(SandboxMessage.org_id == ctx.org_id,
                                                                func.lower(SandboxMessage.to) == email))).all()
    result = {"crm_records": [c.data for c in crm], "outbox_messages": len(outbox),
              "not_covered": ["Uploaded knowledge documents", "Connected external systems",
                              "Execution inputs/outputs (retained per retention policy)"]}
    if body.kind == "erasure":
        for c in crm:
            await ctx.db.delete(c)
        for m in outbox:
            await ctx.db.delete(m)
        result = {"erased_crm_records": len(crm), "erased_outbox_messages": len(outbox),
                  "not_covered": result["not_covered"]}
    r = DataSubjectRequest(org_id=ctx.org_id, kind=body.kind, subject_email=email, status="completed",
                           result=result, created_by=ctx.user.id, completed_at=datetime.now(UTC))
    ctx.db.add(r)
    await ctx.audit(f"privacy.{body.kind}", "data_subject_request", None, subject=sha256(email)[:16])
    await ctx.db.commit()
    return {"id": r.id, "result": result}


# ------------------------------------------------------------------ EU AI Act assessment
class AssessIn(BaseModel):
    workflow_id: UUID | None = None
    agent_id: UUID | None = None
    intended_purpose: str = Field(min_length=10)
    deployment_context: str = ""
    industry: str | None = None
    answers: dict[str, bool] = {}


ANNEX_III = {
    "biometrics": "Biometric identification or categorisation",
    "critical_infrastructure": "Safety component of critical infrastructure",
    "education": "Admission, assessment or proctoring in education",
    "employment": "Recruitment, selection, promotion, termination or task allocation of workers",
    "essential_services": "Access to essential services, credit scoring, insurance pricing",
    "law_enforcement": "Law enforcement, migration, asylum or border control",
    "justice": "Administration of justice or democratic processes",
}
PROHIBITED = {
    "manipulation": "Subliminal or manipulative techniques causing harm",
    "social_scoring": "Social scoring",
    "emotion_workplace": "Emotion recognition in the workplace or education",
}


@router.get("/compliance/ai-act/questions")
async def ai_act_questions(ctx: Viewer):
    return {"prohibited": PROHIBITED, "high_risk": ANNEX_III,
            "transparency": {"interacts_with_people": "The system interacts directly with people",
                             "generates_content": "The system generates text/images shown to the public"}}


def classify(answers: dict[str, bool]) -> tuple[str, list[str]]:
    if any(answers.get(k) for k in PROHIBITED):
        return "prohibited_check", ["Potentially prohibited practice (Art. 5) — do not deploy; obtain legal review."]
    if any(answers.get(k) for k in ANNEX_III):
        return "high_risk_candidate", [
            "Possible high-risk use (Annex III): risk management, data governance, logging, human oversight, "
            "accuracy and robustness obligations may apply.",
            "Deployer duties include human oversight, monitoring and informing affected persons.",
            "Qualified legal review is required before production use."]
    obligations = []
    if answers.get("interacts_with_people"):
        obligations.append("Inform people they are interacting with an AI system (Art. 50).")
    if answers.get("generates_content"):
        obligations.append("Mark or disclose AI-generated content where required (Art. 50).")
    return ("limited" if obligations else "minimal"), obligations + [
        "Keep this assessment up to date when the purpose or context changes."]


@router.post("/compliance/ai-act", status_code=201)
async def ai_act_create(body: AssessIn, ctx: Manager):
    risk, obligations = classify(body.answers)
    a = AIActAssessment(org_id=ctx.org_id, workflow_id=body.workflow_id, agent_id=body.agent_id,
                        intended_purpose=body.intended_purpose, deployment_context=body.deployment_context,
                        industry=body.industry, answers=body.answers, risk_class=risk, obligations=obligations,
                        status="needs_legal_review" if risk in ("prohibited_check", "high_risk_candidate")
                        else "self_assessed", created_by=ctx.user.id)
    ctx.db.add(a)
    await ctx.audit("compliance.ai_act_assessed", "ai_act_assessment", None, risk=risk)
    await ctx.db.commit()
    return {"id": a.id, "risk_class": risk, "obligations": obligations, "status": a.status,
            "disclaimer": "This is a structured self-assessment, not a determination of legal compliance."}


@router.get("/compliance/ai-act")
async def ai_act_list(ctx: Viewer):
    rows = (await ctx.db.scalars(select(AIActAssessment).where(AIActAssessment.org_id == ctx.org_id)
                                 .order_by(AIActAssessment.created_at.desc()))).all()
    return [{"id": a.id, "workflow_id": a.workflow_id, "agent_id": a.agent_id, "purpose": a.intended_purpose,
             "risk_class": a.risk_class, "obligations": a.obligations, "status": a.status,
             "created_at": a.created_at} for a in rows]


class ReviewIn(BaseModel):
    note: str = Field(min_length=3)


@router.post("/compliance/ai-act/{aid}/review")
async def ai_act_review(aid: UUID, body: ReviewIn, ctx: Owner):
    a = await ctx.db.get(AIActAssessment, aid)
    if not a or a.org_id != ctx.org_id:
        raise HTTPException(404, "Assessment not found")
    if a.risk_class == "prohibited_check":
        raise HTTPException(400, "Potentially prohibited practices cannot be marked reviewed here")
    a.status, a.reviewer_note = "reviewed", body.note
    await ctx.audit("compliance.ai_act_reviewed", "ai_act_assessment", aid)
    await ctx.db.commit()
    return {"ok": True}
