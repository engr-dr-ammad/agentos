import re
from datetime import UTC, datetime
from typing import Any, Literal
from uuid import UUID

from croniter import croniter
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..deps import Employee, Manager, Viewer, get_or_404
from ..engine.worker import next_run
from ..models import Agent, Organization, Schedule, Task, TaskEvent, Workflow, WorkflowExecution
from ..templates_registry import suggest

router = APIRouter(tags=["tasks"])

STATES = ["Draft", "Ready", "Queued", "Running", "Awaiting Approval", "Paused", "Completed", "Failed",
          "Cancelled", "Expired"]
TRANSITIONS: dict[str, set[str]] = {
    "Draft": {"Ready", "Cancelled"},
    "Ready": {"Queued", "Paused", "Cancelled", "Expired", "Draft"},
    "Queued": {"Running", "Cancelled", "Failed"},
    "Running": {"Completed", "Failed", "Awaiting Approval", "Paused", "Cancelled"},
    "Awaiting Approval": {"Running", "Completed", "Failed", "Cancelled", "Expired"},
    "Paused": {"Ready", "Cancelled"},
    "Completed": {"Ready", "Queued"},  # recurring tasks run again
    "Failed": {"Ready", "Queued", "Cancelled"},
    "Cancelled": set(),
    "Expired": set(),
}
Priority = Literal["low", "normal", "high", "urgent"]


class InvalidTransition(HTTPException):
    def __init__(self, a: str, b: str):
        super().__init__(409, f"A task cannot move from '{a}' to '{b}'")


async def transition(db: AsyncSession, task: Task, to: str, *, actor_id: UUID | None, note: str | None = None,
                     strict: bool = True) -> None:
    """Server-side state machine. Engine callbacks use strict=False to tolerate idempotent replays."""
    if to == task.status:
        return
    if to not in TRANSITIONS.get(task.status, set()):
        if strict:
            raise InvalidTransition(task.status, to)
        return
    db.add(TaskEvent(org_id=task.org_id, task_id=task.id, from_status=task.status, to_status=to,
                     actor_id=actor_id, note=note))
    task.status = to


class TaskIn(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    description: str = ""
    agent_id: UUID | None = None
    workflow_id: UUID | None = None
    owner_id: UUID | None = None
    priority: Priority = "normal"
    due_at: datetime | None = None
    schedule_cron: str | None = None
    inputs: dict[str, Any] = {}
    expected_output: str | None = None
    requires_approval: bool = True
    dependencies: list[UUID] = []
    status: Literal["Draft", "Ready"] = "Draft"

    @field_validator("schedule_cron")
    @classmethod
    def _cron(cls, v):
        if v and not croniter.is_valid(v):
            raise ValueError("Invalid schedule")
        return v or None


class TaskPatch(BaseModel):
    title: str | None = None
    description: str | None = None
    agent_id: UUID | None = None
    owner_id: UUID | None = None
    priority: Priority | None = None
    due_at: datetime | None = None
    inputs: dict[str, Any] | None = None
    expected_output: str | None = None
    requires_approval: bool | None = None


def task_out(t: Task, agent_name: str | None = None) -> dict:
    return {"id": t.id, "title": t.title, "description": t.description, "agent_id": t.agent_id,
            "agent_name": agent_name, "workflow_id": t.workflow_id, "owner_id": t.owner_id, "priority": t.priority,
            "status": t.status, "due_at": t.due_at, "schedule_cron": t.schedule_cron, "inputs": t.inputs,
            "expected_output": t.expected_output, "requires_approval": t.requires_approval,
            "dependencies": t.dependencies, "result": t.result, "cost_usd": float(t.cost_usd or 0),
            "error": t.error, "created_at": t.created_at, "updated_at": t.updated_at,
            "allowed_transitions": sorted(TRANSITIONS.get(t.status, set()))}


@router.get("/tasks")
async def list_tasks(ctx: Viewer, status: str | None = None, agent_id: UUID | None = None):
    q = select(Task, Agent.name).outerjoin(Agent, Agent.id == Task.agent_id).where(Task.org_id == ctx.org_id)
    if status:
        q = q.where(Task.status == status)
    if agent_id:
        q = q.where(Task.agent_id == agent_id)
    rows = (await ctx.db.execute(q.order_by(Task.created_at.desc()).limit(500))).all()
    return [task_out(t, n) for t, n in rows]


async def _check_refs(ctx, agent_id, workflow_id):
    if agent_id:
        await get_or_404(ctx.db, Agent, agent_id, ctx.org_id, "Agent")
    if workflow_id:
        await get_or_404(ctx.db, Workflow, workflow_id, ctx.org_id, "Workflow")


@router.post("/tasks", status_code=201)
async def create_task(body: TaskIn, ctx: Employee):
    await _check_refs(ctx, body.agent_id, body.workflow_id)
    if body.status == "Ready" and not (body.agent_id or body.workflow_id or body.owner_id):
        raise HTTPException(422, "Assign the task to an agent, a workflow or a person")
    t = Task(org_id=ctx.org_id, created_by=ctx.user.id, **body.model_dump(exclude={"dependencies", "status"}),
             dependencies=[str(d) for d in body.dependencies], status="Draft")
    t.owner_id = t.owner_id or ctx.user.id
    ctx.db.add(t)
    await ctx.db.flush()
    ctx.db.add(TaskEvent(org_id=ctx.org_id, task_id=t.id, from_status=None, to_status="Draft", actor_id=ctx.user.id))
    if body.status == "Ready":
        await transition(ctx.db, t, "Ready", actor_id=ctx.user.id)
    await _sync_schedule(ctx.db, t, ctx.org_id)
    await ctx.audit("task.created", "task", t.id, title=t.title)
    await ctx.db.commit()
    return task_out(t)


async def _sync_schedule(db: AsyncSession, t: Task, org_id: UUID) -> None:
    s = await db.scalar(select(Schedule).where(Schedule.task_id == t.id))
    active = bool(t.schedule_cron) and t.status in ("Ready", "Completed", "Failed", "Running", "Queued",
                                                     "Awaiting Approval")
    if t.schedule_cron:
        org = await db.get(Organization, org_id)
        tz = org.timezone or "UTC"
        if s is None:
            db.add(Schedule(org_id=org_id, task_id=t.id, cron=t.schedule_cron, timezone=tz,
                            next_run_at=next_run(t.schedule_cron, tz), enabled=active))
        else:
            s.cron, s.enabled = t.schedule_cron, active
    elif s is not None:
        await db.delete(s)


@router.get("/tasks/{tid}")
async def get_task(tid: UUID, ctx: Viewer):
    t = await get_or_404(ctx.db, Task, tid, ctx.org_id, "Task")
    events = (await ctx.db.scalars(select(TaskEvent).where(TaskEvent.task_id == tid)
                                   .order_by(TaskEvent.created_at))).all()
    execs = (await ctx.db.scalars(select(WorkflowExecution).where(WorkflowExecution.task_id == tid)
                                  .order_by(WorkflowExecution.created_at.desc()).limit(20))).all()
    agent = await ctx.db.get(Agent, t.agent_id) if t.agent_id else None
    return {**task_out(t, agent.name if agent else None),
            "events": [{"from": e.from_status, "to": e.to_status, "at": e.created_at, "note": e.note} for e in events],
            "executions": [{"id": e.id, "status": e.status, "created_at": e.created_at,
                            "cost_usd": float(e.cost_usd or 0)} for e in execs]}


@router.patch("/tasks/{tid}")
async def update_task(tid: UUID, body: TaskPatch, ctx: Employee):
    t = await get_or_404(ctx.db, Task, tid, ctx.org_id, "Task")
    if t.status in ("Running", "Queued"):
        raise HTTPException(409, "A running task cannot be edited")
    data = body.model_dump(exclude_unset=True)
    await _check_refs(ctx, data.get("agent_id"), None)
    for k, v in data.items():
        setattr(t, k, v)
    await ctx.db.commit()
    return task_out(t)


class TransitionIn(BaseModel):
    to: Literal["Ready", "Paused", "Cancelled", "Draft"]
    note: str | None = None


@router.post("/tasks/{tid}/transition")
async def move(tid: UUID, body: TransitionIn, ctx: Employee):
    t = await get_or_404(ctx.db, Task, tid, ctx.org_id, "Task")
    if body.to == "Ready" and not (t.agent_id or t.workflow_id or t.owner_id):
        raise HTTPException(422, "Assign the task first")
    await transition(ctx.db, t, body.to, actor_id=ctx.user.id, note=body.note)
    if body.to == "Cancelled":
        running = (await ctx.db.scalars(select(WorkflowExecution).where(
            WorkflowExecution.task_id == tid,
            WorkflowExecution.status.in_(["queued", "running", "awaiting_approval", "waiting"])))).all()
        for e in running:
            e.cancel_requested = True
    await _sync_schedule(ctx.db, t, ctx.org_id)
    await ctx.audit(f"task.{body.to.lower()}", "task", tid)
    await ctx.db.commit()
    return task_out(t)


async def run_task(db: AsyncSession, t: Task, actor: UUID | None, recurring: bool = False) -> WorkflowExecution:
    from .workflows import start_execution

    if t.status not in ("Ready", "Failed") and not (recurring and t.status == "Completed"):
        raise HTTPException(409, f"Only ready tasks can run (current status: {t.status})")
    for dep in t.dependencies or []:
        d = await db.get(Task, UUID(str(dep)))
        if d and d.status != "Completed":
            raise HTTPException(409, f"Waiting for dependency '{d.title}' to complete")
    await transition(db, t, "Queued", actor_id=actor, note="Run requested", strict=False)
    if t.workflow_id:
        wf = await db.get(Workflow, t.workflow_id)
        return await start_execution(db, t.org_id, wf, input={**(t.inputs or {}), "task": t.title},
                                     trigger_type="task", user_id=actor, task_id=t.id)
    if not t.agent_id:
        raise HTTPException(422, "This task is assigned to a person, not an agent or workflow")
    defn = {"nodes": [
        {"id": "trigger", "type": "trigger.manual", "data": {"label": "Task", "config": {}}},
        {"id": "agent", "type": "agent", "data": {"label": "Agent", "config": {
            "agent_id": str(t.agent_id), "task": f"{t.title}\n\n{t.description}\n\nExpected output: "
                                                 f"{t.expected_output or 'as appropriate'}",
            "input": "{{ trigger }}"}}},
        {"id": "end", "type": "control.end", "data": {"label": "Result",
                                                      "config": {"result": {"output": "{{ nodes.agent.result }}",
                                                                            "sources": "{{ nodes.agent.sources }}"}}}}],
        "edges": [{"id": "e1", "source": "trigger", "target": "agent"},
                  {"id": "e2", "source": "agent", "target": "end"}]}
    return await start_execution(db, t.org_id, None, input=t.inputs or {}, trigger_type="task", user_id=actor,
                                 task_id=t.id, definition=defn)


@router.post("/tasks/{tid}/run", status_code=202)
async def run(tid: UUID, ctx: Employee):
    t = await get_or_404(ctx.db, Task, tid, ctx.org_id, "Task")
    ex = await run_task(ctx.db, t, ctx.user.id)
    await ctx.audit("task.run", "task", tid, execution_id=str(ex.id))
    await ctx.db.commit()
    return {"execution_id": ex.id, "status": t.status}


class ReviewIn(BaseModel):
    decision: Literal["accept", "reject"]
    note: str | None = None


@router.post("/tasks/{tid}/review")
async def review(tid: UUID, body: ReviewIn, ctx: Manager):
    """Human review of an agent-only task result (no external action involved)."""
    t = await get_or_404(ctx.db, Task, tid, ctx.org_id, "Task")
    if t.status != "Awaiting Approval":
        raise HTTPException(409, "This task is not awaiting review")
    if t.workflow_id:
        raise HTTPException(409, "Workflow approvals are decided in the Approval Centre")
    await transition(ctx.db, t, "Completed" if body.decision == "accept" else "Failed", actor_id=ctx.user.id,
                     note=body.note or f"Result {body.decision}ed")
    await ctx.audit(f"task.review_{body.decision}", "task", tid)
    await ctx.db.commit()
    return task_out(t)


# ------------------------------------------------------------------ natural language → structured task
DAYS = {"monday": 1, "tuesday": 2, "wednesday": 3, "thursday": 4, "friday": 5, "saturday": 6, "sunday": 0}


def parse_schedule(text: str) -> tuple[str | None, str | None]:
    s = text.lower()
    hour, minute = 9, 0
    if m := re.search(r"\bat\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?", s):
        hour, minute = int(m.group(1)), int(m.group(2) or 0)
        ap = (m.group(3) or "").replace(".", "")
        if ap == "pm" and hour < 12:
            hour += 12
        if ap == "am" and hour == 12:
            hour = 0
        if not (0 <= hour < 24 and 0 <= minute < 60):
            return None, None
    hm = f"{minute} {hour}"
    if re.search(r"\b(every|each)\s+hour\b|\bhourly\b", s):
        return "0 * * * *", "Every hour"
    days = [d for d in DAYS if re.search(rf"\b{d}s?\b", s)]
    if re.search(r"\b(every|each)\s+(week)?day\b|\bdaily\b|\bevery morning\b", s):
        if "weekday" in s:
            return f"{hm} * * 1-5", f"Weekdays at {hour:02d}:{minute:02d}"
        return f"{hm} * * *", f"Every day at {hour:02d}:{minute:02d}"
    if days and re.search(r"\b(every|each|on)\b", s):
        dow = ",".join(str(DAYS[d]) for d in days)
        return f"{hm} * * {dow}", f"Every {', '.join(d.title() for d in days)} at {hour:02d}:{minute:02d}"
    if re.search(r"\bweekly\b|\bevery week\b", s):
        return f"{hm} * * 1", f"Every Monday at {hour:02d}:{minute:02d}"
    if re.search(r"\bmonthly\b|\bevery month\b", s):
        return f"{hm} 1 * *", f"1st of every month at {hour:02d}:{minute:02d}"
    return None, None


class ParseIn(BaseModel):
    text: str = Field(min_length=5, max_length=4000)


@router.post("/tasks/parse")
async def parse_task(body: ParseIn, ctx: Employee):
    """Convert a plain-English request into a structured task proposal for the user to confirm."""
    cron, human = parse_schedule(body.text)
    agents = (await ctx.db.scalars(select(Agent).where(Agent.org_id == ctx.org_id))).all()
    matched = suggest(body.text, k=3)
    agent = next((a for t in matched for a in agents if a.template_id == t.id), None)
    if agent is None:
        words = set(re.findall(r"\w{4,}", body.text.lower()))
        agent = max(agents, key=lambda a: len(words & set(re.findall(r"\w{4,}", f"{a.name} {a.description}".lower()))),
                    default=None)
    sentence = re.split(r"[.!?\n]", body.text.strip())[0]
    title = re.sub(r"^(every|each)\s+\w+(\s+at\s+[\d:apm. ]+)?,?\s*", "", sentence, flags=re.I).strip() or sentence
    needs_approval = bool(re.search(r"\b(send|email|pay|publish|delete|order|purchase|remind|post)\w*", body.text, re.I))
    return {"title": title[:1].upper() + title[1:300], "description": body.text, "schedule_cron": cron,
            "schedule_human": human, "agent_id": agent.id if agent else None,
            "agent_name": agent.name if agent else None,
            "suggested_template": matched[0].id if matched and not agent else None,
            "requires_approval": True if needs_approval else False,
            "approval_reason": "The request involves external communication or money." if needs_approval else None,
            "next_runs": [next_run(cron, "UTC", datetime.now(UTC)).isoformat()] if cron else [],
            "confirm_required": True}
