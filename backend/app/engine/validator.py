"""Workflow validation with plain-English messages."""

from collections import defaultdict, deque
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from croniter import croniter
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Agent, AgentVersion, IntegrationConnection, KnowledgeBase, LLMProvider
from .catalog import NODE_TYPES, SIDE_EFFECTS, TRIGGERS, is_mandatory_approval
from .templating import referenced_nodes

MAX_NODES = 200


@dataclass
class Lookup:
    agents: dict[str, dict] = field(default_factory=dict)  # id -> {name,status,mode,provider_id,version}
    connections: dict[str, dict] = field(default_factory=dict)  # id -> {kind,status,name,allowed}
    kbs: set[str] = field(default_factory=set)
    providers: set[str] = field(default_factory=set)
    workflow_id: str | None = None


@dataclass
class Graph:
    nodes: dict[str, dict]
    out: dict[str, list[dict]]
    inc: dict[str, list[dict]]
    order: list[str] | None  # topological order, None if cyclic


def build_graph(defn: dict) -> Graph:
    nodes = {n["id"]: n for n in defn.get("nodes", []) if isinstance(n, dict) and n.get("id")}
    out: dict[str, list[dict]] = defaultdict(list)
    inc: dict[str, list[dict]] = defaultdict(list)
    for e in defn.get("edges", []):
        if e.get("source") in nodes and e.get("target") in nodes:
            out[e["source"]].append(e)
            inc[e["target"]].append(e)
    indeg = {n: len(inc[n]) for n in nodes}
    q = deque(sorted(n for n, d in indeg.items() if d == 0))
    order = []
    while q:
        n = q.popleft()
        order.append(n)
        for e in out[n]:
            indeg[e["target"]] -= 1
            if indeg[e["target"]] == 0:
                q.append(e["target"])
    return Graph(nodes, out, inc, order if len(order) == len(nodes) else None)


def ancestors(g: Graph, nid: str) -> set[str]:
    seen: set[str] = set()
    stack = [e["source"] for e in g.inc[nid]]
    while stack:
        n = stack.pop()
        if n not in seen:
            seen.add(n)
            stack.extend(e["source"] for e in g.inc[n])
    return seen


def reachable_avoiding(g: Graph, starts: list[str], target: str, avoid: str) -> bool:
    seen, stack = set(), [s for s in starts if s != avoid]
    while stack:
        n = stack.pop()
        if n == target:
            return True
        if n in seen:
            continue
        seen.add(n)
        stack.extend(e["target"] for e in g.out[n] if e["target"] != avoid)
    return False


def validate(defn: dict, lk: Lookup) -> list[dict[str, Any]]:
    issues: list[dict[str, Any]] = []

    def err(nid: str | None, msg: str, severity: str = "error"):
        issues.append({"node_id": nid, "severity": severity, "message": msg})

    g = build_graph(defn)
    if not g.nodes:
        return [{"node_id": None, "severity": "error", "message": "Add a trigger to start your workflow."}]
    if len(g.nodes) > MAX_NODES:
        err(None, f"Workflows are limited to {MAX_NODES} steps.")
    for e in defn.get("edges", []):
        if e.get("source") not in g.nodes or e.get("target") not in g.nodes:
            err(None, "A connection points to a step that no longer exists.")
    triggers = [n for n, v in g.nodes.items() if v.get("type") in TRIGGERS]
    if len(triggers) != 1:
        err(None, "A workflow needs exactly one trigger." if not triggers else
            "Only one trigger is allowed per workflow — split it into separate workflows.")
    if g.order is None:
        err(None, "Your workflow contains a loop. Loops are not supported; use a schedule or retry settings.")
        return issues

    label = {n: (v.get("data", {}).get("label") or NODE_TYPES.get(v.get("type"), {}).get("label") or n)
             for n, v in g.nodes.items()}
    reachable: set[str] = set()
    stack = list(triggers)
    while stack:
        n = stack.pop()
        if n not in reachable:
            reachable.add(n)
            stack.extend(e["target"] for e in g.out[n])

    approvals_for: dict[str, list[str]] = defaultdict(list)
    for nid, node in g.nodes.items():
        t = node.get("type")
        spec = NODE_TYPES.get(t)
        name = label[nid]
        if spec is None:
            err(nid, f"'{name}' uses an unknown step type '{t}'.")
            continue
        cfg = node.get("data", {}).get("config", {}) or {}
        if nid not in reachable:
            err(nid, f"'{name}' is not connected to the trigger, so it would never run.")
        for f in spec["fields"]:
            if f["required"] and cfg.get(f["key"]) in (None, "", [], {}):
                err(nid, f"'{name}' needs a value for “{f['label']}”.")
        for e in g.out[nid]:
            h = e.get("sourceHandle")
            if h and h != "default" and h not in spec["outputs"]:
                err(nid, f"'{name}' has a connection from an unknown output '{h}'.")
        if not spec["outputs"] and g.out[nid]:
            err(nid, f"'{name}' ends the workflow and cannot have outgoing connections.")

        refs, syntax = referenced_nodes(cfg)
        for s in syntax:
            err(nid, f"'{name}' has a template error: {s}")
        anc = ancestors(g, nid)
        for r in refs:
            if r not in g.nodes:
                err(nid, f"'{name}' refers to a step '{r}' that does not exist.")
            elif r not in anc:
                err(nid, f"'{name}' uses data from '{label[r]}', which does not run before it.")

        if t == "trigger.schedule" and cfg.get("cron") and not croniter.is_valid(cfg["cron"]):
            err(nid, f"'{name}' has an invalid schedule '{cfg['cron']}'.")
        if t == "agent" and cfg.get("agent_id"):
            a = lk.agents.get(str(cfg["agent_id"]))
            if not a:
                err(nid, f"'{name}' uses an agent that no longer exists.")
            else:
                if a["status"] in ("disabled", "paused"):
                    err(nid, f"Agent '{a['name']}' is {a['status']}. Activate it before publishing.", "warning")
                if a.get("provider_id") and a["provider_id"] not in lk.providers:
                    err(nid, f"Agent '{a['name']}' uses an AI model connection that was removed.")
                if not a.get("provider_id") and not lk.providers:
                    err(nid, f"Agent '{a['name']}' needs an AI model. Add one under Integrations → AI models.")
                for kb in a.get("kb_ids", []):
                    if kb not in lk.kbs:
                        err(nid, f"Agent '{a['name']}' is linked to a knowledge base that was deleted.")
        if t == "knowledge.search":
            for kb in cfg.get("kb_ids") or []:
                if str(kb) not in lk.kbs:
                    err(nid, f"'{name}' searches a knowledge base that does not exist.")
        if t in SIDE_EFFECTS and cfg.get("connection_id"):
            c = lk.connections.get(str(cfg["connection_id"]))
            if not c:
                err(nid, f"'{name}' needs a connected app. The selected connection is missing.")
            else:
                if c["kind"] not in spec.get("connection_kinds", []):
                    err(nid, f"'{name}' cannot use the connection '{c['name']}' ({c['kind']}).")
                if c["status"] != "active":
                    err(nid, f"The connection '{c['name']}' used by '{name}' has been revoked.")
                allowed = c.get("allowed")
                if allowed is not None and lk.workflow_id and lk.workflow_id not in allowed:
                    err(nid, f"This workflow is not permitted to use '{c['name']}'. "
                             "Allow it under Integrations.")
        if t == "human.approval" and cfg.get("action_node"):
            target = cfg["action_node"]
            approvals_for[target].append(nid)
            if target not in g.nodes or g.nodes[target].get("type") not in SIDE_EFFECTS:
                err(nid, f"'{name}' must be linked to an action step (email, CRM or API).")
            else:
                # The approval preview renders the action's payload, so its data must exist by then.
                tcfg = g.nodes[target].get("data", {}).get("config", {}) or {}
                trefs, _ = referenced_nodes(tcfg)
                missing = [label[r] for r in trefs if r in g.nodes and r not in anc]
                if missing:
                    err(nid, f"'{name}' runs before {', '.join(missing)}, whose data the approved action uses. "
                             "Move the approval after those steps.")
        if t == "control.delay" and not (0 < float(cfg.get("seconds") or 0) <= 30 * 86400):
            err(nid, f"'{name}' must wait between 1 second and 30 days.")
        if t == "finance.price_check" and cfg.get("max_discount_pct") not in (None, ""):
            if not 0 <= float(cfg["max_discount_pct"]) <= 100:
                err(nid, f"'{name}' has an invalid maximum discount.")

    # Approval coverage: sensitive actions (and every action downstream of a draft-only /
    # approval-required agent) must be dominated by an approval bound to that exact action.
    for nid, node in g.nodes.items():
        t = node.get("type")
        if t not in SIDE_EFFECTS:
            continue
        cfg = node.get("data", {}).get("config", {}) or {}
        if is_mandatory_approval(t, cfg):
            bound = approvals_for.get(nid, [])
            if not bound:
                err(nid, f"'{label[nid]}' needs a human approval step linked to it before it can run.")
            elif not any(not reachable_avoiding(g, triggers, nid, ap) for ap in bound):
                err(nid, f"'{label[nid]}' can be reached without passing its approval step.")
            continue
        # Actions fed by draft-only / approval-required agents must sit behind a human checkpoint.
        supervised = [lk.agents.get(str(g.nodes[a].get("data", {}).get("config", {}).get("agent_id")))
                      for a in ancestors(g, nid) if g.nodes[a].get("type") == "agent"]
        if any(ag and ag.get("mode") in ("draft_only", "approval_required") for ag in supervised):
            gates = [n for n, v in g.nodes.items() if v.get("type") == "human.approval"]
            if not any(not reachable_avoiding(g, triggers, nid, ap) for ap in gates):
                err(nid, f"'{label[nid]}' uses output from an agent that requires approval. "
                         "Add an approval step before it.")

    has_end = any(v.get("type") == "control.end" for v in g.nodes.values())
    if not has_end:
        err(None, "Tip: add an End step to define what the workflow returns.", "info")
    return issues


async def load_lookup(db: AsyncSession, org_id: UUID, workflow_id: UUID | None) -> Lookup:
    lk = Lookup(workflow_id=str(workflow_id) if workflow_id else None)
    rows = (await db.execute(
        select(Agent, AgentVersion.config).join(
            AgentVersion, (AgentVersion.agent_id == Agent.id) & (AgentVersion.version == Agent.current_version))
        .where(Agent.org_id == org_id))).all()
    for a, cfg in rows:
        lk.agents[str(a.id)] = {"name": a.name, "status": a.status, "mode": cfg.get("mode"),
                                "provider_id": cfg.get("provider_id"), "kb_ids": cfg.get("knowledge_base_ids", []),
                                "version": a.current_version}
    for c in (await db.scalars(select(IntegrationConnection).where(IntegrationConnection.org_id == org_id))).all():
        lk.connections[str(c.id)] = {"kind": c.kind, "status": c.status, "name": c.name,
                                     "allowed": c.allowed_workflow_ids}
    lk.kbs = {str(i) for i in (await db.scalars(select(KnowledgeBase.id).where(KnowledgeBase.org_id == org_id)))}
    lk.providers = {str(i) for i in (await db.scalars(select(LLMProvider.id).where(LLMProvider.org_id == org_id)))}
    return lk


def blocking(issues: list[dict]) -> bool:
    return any(i["severity"] == "error" for i in issues)
