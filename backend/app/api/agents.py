import json
from decimal import Decimal
from typing import Any, Literal
from uuid import UUID

from fastapi import APIRouter, HTTPException
from jsonschema import Draft202012Validator, SchemaError
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import case, func, select

from ..db import tenant_session
from ..deps import Employee, Manager, Viewer, get_or_404
from ..engine.executor import run_execution
from ..llm import service as llm
from ..llm.base import LLMError, Message
from ..models import (
    Agent,
    AgentVersion,
    KnowledgeBase,
    LLMProvider,
    NodeExecution,
    Organization,
    WorkflowExecution,
)
from ..plans import limit as plan_limit
from ..templates_registry import TEMPLATES, suggest

router = APIRouter(tags=["agents"])
Mode = Literal["draft_only", "approval_required", "limited_autonomy", "controlled_autonomy"]
DEFAULT_SCHEMA = {"type": "object", "properties": {"result": {"type": "string"}}, "required": ["result"]}


class AgentConfig(BaseModel):
    role: str = Field("", max_length=2000)
    instructions: str = Field("", max_length=20_000)
    mode: Mode = "approval_required"
    provider_id: UUID | None = None
    model: str | None = None
    temperature: float = Field(0.2, ge=0, le=2)
    max_tokens: int = Field(1500, ge=64, le=32_000)
    output_schema: dict[str, Any] = DEFAULT_SCHEMA
    knowledge_base_ids: list[UUID] = []
    retrieval_k: int = Field(5, ge=1, le=20)

    @field_validator("output_schema")
    @classmethod
    def _schema(cls, v):
        try:
            Draft202012Validator.check_schema(v)
        except SchemaError as e:
            raise ValueError(f"Invalid output schema: {e.message}") from e
        return v


class AgentIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field("", max_length=2000)
    department: str | None = None
    escalation_contact: str | None = None
    monthly_budget_usd: Decimal | None = Field(None, ge=0)
    template_id: str | None = None
    config: AgentConfig = AgentConfig()


class AgentPatch(BaseModel):
    name: str | None = Field(None, max_length=120)
    description: str | None = None
    department: str | None = None
    escalation_contact: str | None = None
    monthly_budget_usd: Decimal | None = Field(None, ge=0)
    owner_id: UUID | None = None
    config: AgentConfig | None = None
    note: str | None = None


def _jsonable(cfg: AgentConfig) -> dict:
    return json.loads(cfg.model_dump_json())


async def _check_refs(ctx, cfg: AgentConfig) -> None:
    if cfg.provider_id and not await ctx.db.scalar(select(LLMProvider.id).where(
            LLMProvider.id == cfg.provider_id, LLMProvider.org_id == ctx.org_id)):
        raise HTTPException(422, "Selected AI model connection does not exist")
    if cfg.knowledge_base_ids:
        n = await ctx.db.scalar(select(func.count()).select_from(KnowledgeBase).where(
            KnowledgeBase.org_id == ctx.org_id, KnowledgeBase.id.in_(cfg.knowledge_base_ids)))
        if n != len(set(cfg.knowledge_base_ids)):
            raise HTTPException(422, "One or more knowledge bases do not exist")


async def _stats(ctx, agent_ids: list[UUID]) -> dict:
    if not agent_ids:
        return {}
    ne = NodeExecution
    rows = (await ctx.db.execute(
        select(ne.input["agent_id"].astext.label("aid"),
               func.count().label("attempted"),
               func.sum(case((ne.status == "completed", 1), else_=0)).label("completed"),
               func.sum(case((ne.status.in_(["failed", "failed_continued"]), 1), else_=0)).label("failed"),
               func.coalesce(func.sum(ne.cost_usd), 0).label("cost"),
               func.avg(func.extract("epoch", ne.finished_at - ne.started_at)).label("avg_seconds"))
        .where(ne.org_id == ctx.org_id, ne.node_type == "agent",
               ne.input["agent_id"].astext.in_([str(a) for a in agent_ids])).group_by("aid"))).all()
    return {r.aid: r for r in rows}


def agent_out(a: Agent, cfg: dict | None = None, stats=None) -> dict:
    out = {"id": a.id, "name": a.name, "description": a.description, "department": a.department,
           "status": a.status, "current_version": a.current_version, "template_id": a.template_id,
           "monthly_budget_usd": a.monthly_budget_usd, "escalation_contact": a.escalation_contact,
           "owner_id": a.owner_id, "created_at": a.created_at, "updated_at": a.updated_at}
    if cfg is not None:
        out["config"] = cfg
    if stats is not None:
        att = stats.attempted or 0
        out["stats"] = {"attempted": att, "completed": stats.completed or 0, "failed": stats.failed or 0,
                        "success_rate": round((stats.completed or 0) / att, 3) if att else None,
                        "cost_usd": float(stats.cost or 0),
                        "avg_seconds": round(float(stats.avg_seconds), 2) if stats.avg_seconds else None}
    return out


@router.get("/agents")
async def list_agents(ctx: Viewer):
    rows = (await ctx.db.execute(select(Agent, AgentVersion.config).join(
        AgentVersion, (AgentVersion.agent_id == Agent.id) & (AgentVersion.version == Agent.current_version))
        .where(Agent.org_id == ctx.org_id).order_by(Agent.department.nulls_last(), Agent.name))).all()
    stats = await _stats(ctx, [a.id for a, _ in rows])
    return [agent_out(a, cfg, stats.get(str(a.id))) for a, cfg in rows]


@router.get("/agents/{aid}")
async def get_agent(aid: UUID, ctx: Viewer):
    a = await get_or_404(ctx.db, Agent, aid, ctx.org_id, "Agent")
    versions = (await ctx.db.scalars(select(AgentVersion).where(AgentVersion.agent_id == aid)
                                     .order_by(AgentVersion.version.desc()))).all()
    stats = (await _stats(ctx, [aid])).get(str(aid))
    cur = next(v.config for v in versions if v.version == a.current_version)
    return {**agent_out(a, cur, stats),
            "versions": [{"version": v.version, "note": v.note, "created_at": v.created_at, "config": v.config}
                         for v in versions]}


async def _enforce_agent_limit(ctx) -> None:
    org = await ctx.db.get(Organization, ctx.org_id)
    cap = plan_limit(org.plan, "agents")
    n = await ctx.db.scalar(select(func.count()).select_from(Agent).where(Agent.org_id == ctx.org_id))
    if cap is not None and n >= cap:
        raise HTTPException(402, f"Your {org.plan} plan allows {cap} agents. Upgrade under Billing.")


@router.post("/agents", status_code=201)
async def create_agent(body: AgentIn, ctx: Manager):
    await _enforce_agent_limit(ctx)
    await _check_refs(ctx, body.config)
    a = Agent(org_id=ctx.org_id, name=body.name, description=body.description, department=body.department,
              escalation_contact=body.escalation_contact, monthly_budget_usd=body.monthly_budget_usd,
              template_id=body.template_id, owner_id=ctx.user.id, status="draft", current_version=1)
    ctx.db.add(a)
    await ctx.db.flush()
    ctx.db.add(AgentVersion(org_id=ctx.org_id, agent_id=a.id, version=1, config=_jsonable(body.config),
                            note="Created", created_by=ctx.user.id))
    await ctx.audit("agent.created", "agent", a.id, name=a.name, template=body.template_id)
    await ctx.db.commit()
    return agent_out(a, _jsonable(body.config))


class FromTemplateIn(BaseModel):
    template_id: str
    name: str | None = None
    department: str | None = None


@router.post("/agents/from-template", status_code=201)
async def add_from_template(body: FromTemplateIn, ctx: Manager):
    t = TEMPLATES.get(body.template_id)
    if not t or t.status != "published":
        raise HTTPException(404, "Template not found")
    return await create_agent(AgentIn(
        name=body.name or t.name, description=t.description, department=body.department or t.department,
        template_id=t.id, config=AgentConfig(role=t.description, instructions=t.instructions + "\n\nConstraints:\n- "
                                             + "\n- ".join(t.safety_constraints), mode=t.default_mode,
                                             output_schema=t.output_schema)), ctx)


@router.patch("/agents/{aid}")
async def update_agent(aid: UUID, body: AgentPatch, ctx: Manager):
    a = await get_or_404(ctx.db, Agent, aid, ctx.org_id, "Agent")
    data = body.model_dump(exclude_unset=True, exclude={"config", "note"})
    for k, v in data.items():
        setattr(a, k, v)
    if body.config is not None:
        await _check_refs(ctx, body.config)
        cur = await ctx.db.scalar(select(AgentVersion.config).where(AgentVersion.agent_id == aid,
                                                                    AgentVersion.version == a.current_version))
        new = _jsonable(body.config)
        if new != cur:  # every configuration change is a new immutable version
            a.current_version += 1
            ctx.db.add(AgentVersion(org_id=ctx.org_id, agent_id=aid, version=a.current_version, config=new,
                                    note=body.note or "Updated", created_by=ctx.user.id))
    await ctx.audit("agent.updated", "agent", aid, version=a.current_version)
    await ctx.db.commit()
    return await get_agent(aid, ctx)


class StatusIn(BaseModel):
    status: Literal["draft", "active", "paused", "disabled"]


@router.post("/agents/{aid}/status")
async def set_status(aid: UUID, body: StatusIn, ctx: Manager):
    a = await get_or_404(ctx.db, Agent, aid, ctx.org_id, "Agent")
    a.status = body.status
    await ctx.audit(f"agent.{body.status}", "agent", aid)
    await ctx.db.commit()
    return {"ok": True, "status": a.status}


class RollbackIn(BaseModel):
    version: int


@router.post("/agents/{aid}/rollback")
async def rollback(aid: UUID, body: RollbackIn, ctx: Manager):
    a = await get_or_404(ctx.db, Agent, aid, ctx.org_id, "Agent")
    v = await ctx.db.scalar(select(AgentVersion).where(AgentVersion.agent_id == aid,
                                                       AgentVersion.version == body.version))
    if not v:
        raise HTTPException(404, "Version not found")
    a.current_version += 1
    ctx.db.add(AgentVersion(org_id=ctx.org_id, agent_id=aid, version=a.current_version, config=v.config,
                            note=f"Rolled back to v{body.version}", created_by=ctx.user.id))
    await ctx.audit("agent.rolled_back", "agent", aid, to=body.version)
    await ctx.db.commit()
    return {"ok": True, "current_version": a.current_version}


@router.delete("/agents/{aid}")
async def delete_agent(aid: UUID, ctx: Manager):
    a = await get_or_404(ctx.db, Agent, aid, ctx.org_id, "Agent")
    await ctx.db.delete(a)
    await ctx.audit("agent.deleted", "agent", aid, name=a.name)
    await ctx.db.commit()
    return {"ok": True}


class TestIn(BaseModel):
    task: str = Field("Process the input.", max_length=5000)
    input: Any = {}
    version: int | None = None


@router.post("/agents/{aid}/test")
async def test_agent(aid: UUID, body: TestIn, ctx: Employee):
    """Run the agent once in test mode and return output, sources, tokens and cost."""
    a = await get_or_404(ctx.db, Agent, aid, ctx.org_id, "Agent")
    defn = {"nodes": [
        {"id": "trigger", "type": "trigger.manual", "data": {"label": "Test input", "config": {}}},
        {"id": "agent", "type": "agent", "data": {"label": a.name, "config": {
            "agent_id": str(a.id), "agent_version": body.version or a.current_version, "task": body.task,
            "input": "{{ trigger }}", "max_attempts": 1}}}],
        "edges": [{"id": "e1", "source": "trigger", "target": "agent"}]}
    ex = WorkflowExecution(org_id=ctx.org_id, workflow_id=None, version=0, definition=defn, mode="test",
                           trigger_type="agent_test", input=body.input if isinstance(body.input, dict)
                           else {"text": body.input}, created_by=ctx.user.id)
    ctx.db.add(ex)
    await ctx.db.commit()
    async with tenant_session(ctx.org_id) as db:
        await run_execution(db, ex.id)
    await ctx.db.refresh(ex)
    ne = await ctx.db.scalar(select(NodeExecution).where(NodeExecution.execution_id == ex.id,
                                                         NodeExecution.node_id == "agent"))
    return {"execution_id": ex.id, "status": ex.status, "error": ex.error,
            "output": ne.output if ne else None, "tokens_in": ne.tokens_in if ne else 0,
            "tokens_out": ne.tokens_out if ne else 0, "cost_usd": float(ne.cost_usd) if ne else 0,
            "duration_seconds": (ne.finished_at - ne.started_at).total_seconds()
            if ne and ne.finished_at and ne.started_at else None}


class DescribeIn(BaseModel):
    description: str = Field(min_length=10, max_length=4000)


@router.post("/agents/propose")
async def propose_agent(body: DescribeIn, ctx: Manager):
    """Option A: describe an agent in plain English → proposed configuration (not saved)."""
    base = suggest(body.description, k=1)[0]
    proposal = {"name": base.name, "description": body.description[:300], "department": base.department,
                "template_id": base.id, "config": {"role": body.description[:2000], "mode": base.default_mode,
                                                   "instructions": base.instructions, "output_schema": base.output_schema},
                "source": "template_match"}
    try:
        provider = await llm.resolve_provider(ctx.db, ctx.org_id, None)
    except LLMError:
        return proposal
    if provider.kind == "sandbox":
        return proposal
    schema = {"type": "object", "properties": {
        "name": {"type": "string"}, "department": {"type": "string"}, "role": {"type": "string"},
        "instructions": {"type": "string"},
        "mode": {"type": "string", "enum": ["draft_only", "approval_required", "limited_autonomy"]},
        "output_fields": {"type": "array", "items": {"type": "string"}}},
        "required": ["name", "role", "instructions", "mode", "output_fields"]}
    try:
        res, _ = await llm.complete(
            ctx.db, org_id=ctx.org_id, provider=provider, model=None, json_mode=True,
            usage_key=f"propose:{ctx.user.id}:{hash(body.description)}", messages=[
                Message("system", "You design safe business AI agent configurations. Prefer approval_required "
                                  "when the agent's work leads to external communication or money."),
                Message("user", f"Design an agent for this request:\n<request>{body.description}</request>\n"
                                f"Return JSON matching: {json.dumps(schema)}")])
        await ctx.db.commit()
        p = json.loads(res.text[res.text.find("{"): res.text.rfind("}") + 1])
        fields = [f for f in p.get("output_fields", []) if isinstance(f, str)][:12] or ["result"]
        return {"name": p["name"][:120], "description": body.description[:300], "department": p.get("department"),
                "template_id": None, "source": "model",
                "config": {"role": p["role"], "instructions": p["instructions"],
                           "mode": p["mode"] if p["mode"] in Mode.__args__ else "approval_required",
                           "output_schema": {"type": "object", "properties": {f: {"type": "string"} for f in fields},
                                             "required": fields}}}
    except (LLMError, ValueError, KeyError, TypeError):
        return proposal


@router.get("/templates")
async def list_templates(ctx: Viewer, category: str | None = None, q: str | None = None):
    out = []
    for t in TEMPLATES.values():
        if t.status != "published" or (category and t.category != category):
            continue
        if q and q.lower() not in f"{t.name} {t.description} {t.category} {' '.join(t.industries)}".lower():
            continue
        out.append(t.model_dump(exclude={"instructions", "test_cases", "keywords"}))
    return out


@router.get("/templates/{tid}")
async def get_template(tid: str, ctx: Viewer):
    t = TEMPLATES.get(tid)
    if not t:
        raise HTTPException(404, "Template not found")
    return t.model_dump(exclude={"keywords"})
