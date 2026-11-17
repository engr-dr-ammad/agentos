import hashlib
import hmac
import json
import uuid

import pytest
from sqlalchemy import select, text, update
from sqlalchemy.exc import DBAPIError

from app.api.tasks import parse_schedule
from app.db import SessionLocal, tenant_session
from app.engine.executor import price_check
from app.engine.worker import drain
from app.gateway import GatewayDenied, ToolRequest, execute
from app.models import Agent, JobQueue, SandboxMessage

from .helpers import Client, signup

pytestmark = pytest.mark.asyncio(loop_scope="session")

CATALOGUE = b"sku,item,unit_price\nCH-1,Ergonomic office chair,189.00\nDK-2,Standing desk,549.00\n"


# ---------------------------------------------------------------- auth, CSRF, tenant isolation
async def test_auth_csrf_and_isolation():
    a, _ = await signup("Alpha")
    b, _ = await signup("Beta")
    agent = await a.ok("POST", "/agents/from-template", json={"template_id": "receptionist"})
    # Other tenant cannot see or fetch it.
    assert all(x["id"] != agent["id"] for x in await b.ok("GET", "/agents"))
    await b.ok("GET", f"/agents/{agent['id']}", expect=404)
    # Row-level security holds even without a WHERE clause.
    me_b = await b.ok("GET", "/auth/me")
    async with tenant_session(me_b["org"]["id"]) as db:
        assert (await db.scalars(select(Agent).where(Agent.id == agent["id"]))).first() is None
    async with SessionLocal() as db:  # no tenant set → no rows at all
        assert (await db.scalars(select(Agent))).first() is None
    # CSRF header required for cookie-authenticated writes.
    r = await a.post("/agents/from-template", json={"template_id": "receptionist"}, headers={"x-agentos-csrf": ""})
    assert r.status_code == 403
    # Unauthenticated access is rejected.
    assert (await Client().get("/agents")).status_code == 401


async def test_password_policy_and_login():
    c = Client()
    r = await c.post("/auth/register", json={"email": "weak@example.com", "password": "short", "name": "x",
                                             "company_name": "x"})
    assert r.status_code == 422
    c2, data = await signup("Gamma")
    login = Client()
    assert (await login.post("/auth/login", json={"email": data["email"], "password": "nope"})).status_code == 401
    await login.ok("POST", "/auth/login", json={"email": data["email"], "password": "correct-horse-42"})
    me = await login.ok("GET", "/auth/me")
    assert me["org"]["role"] == "owner"


async def test_audit_log_is_append_only():
    c, _ = await signup("Audit")
    me = await c.ok("GET", "/auth/me")
    async with tenant_session(me["org"]["id"]) as db:
        with pytest.raises(DBAPIError, match="append-only|permission denied"):
            await db.execute(text("UPDATE audit_events SET action = 'tampered'"))
            await db.commit()


# ---------------------------------------------------------------- the reference workflow
async def _setup_quotation(c: Client) -> dict:
    kb = await c.ok("POST", "/knowledge/bases", json={"name": "Product catalogue"})
    await c.ok("POST", f"/knowledge/bases/{kb['id']}/documents",
               files={"file": ("catalogue.csv", CATALOGUE, "text/csv")})
    hits = await c.ok("POST", "/knowledge/search", json={"query": "office chair", "kb_ids": [kb["id"]]})
    assert hits and "chair" in hits[0]["content"].lower()
    rec = await c.ok("POST", "/agents/from-template", json={"template_id": "receptionist"})
    sales = await c.ok("POST", "/agents/from-template", json={"template_id": "sales-quotation"})
    sales_cfg = (await c.ok("GET", f"/agents/{sales['id']}"))["config"]
    await c.ok("PATCH", f"/agents/{sales['id']}", json={"config": {**sales_cfg, "knowledge_base_ids": [kb["id"]]}})
    for ag in (rec, sales):
        await c.ok("POST", f"/agents/{ag['id']}/status", json={"status": "active"})
    conns = {x["kind"]: x["id"] for x in await c.ok("GET", "/connections")}
    node = lambda i, t, cfg, x=0: {"id": i, "type": t, "position": {"x": x, "y": 0},  # noqa: E731
                                   "data": {"label": i, "config": cfg}}
    draft = {
        "nodes": [
            node("enquiry", "trigger.manual", {}),
            node("reception", "agent", {"agent_id": rec["id"], "task": "Extract the request", "input": "{{ trigger }}"}),
            node("sales", "agent", {"agent_id": sales["id"], "task": "Draft a quotation",
                                    "input": "{{ nodes.reception.result }}"}),
            node("pricing", "finance.price_check", {"items": "{{ nodes.sales.result.line_items }}", "currency": "EUR",
                                                    "tax_rate_pct": 19, "max_discount_pct": 15}),
            node("approve", "human.approval", {"title": "Send quotation to {{ nodes.reception.result.customer_name }}",
                                               "action_node": "email", "amount": "{{ nodes.pricing.total }}"}),
            node("email", "action.send_email", {"connection_id": conns["sandbox_email"],
                                                "to": "{{ nodes.reception.result.email }}",
                                                "subject": "Your quotation",
                                                "body": "{{ nodes.sales.result.cover_note }}\nTotal: "
                                                        "{{ nodes.pricing.total }} {{ nodes.pricing.currency }}"}),
            node("crm", "action.crm_upsert", {"connection_id": conns["sandbox_crm"],
                                              "key": "{{ nodes.reception.result.email }}",
                                              "fields": {"status": "quoted", "total": "{{ nodes.pricing.total }}"}}),
            node("end", "control.end", {"result": {"total": "{{ nodes.pricing.total }}"}}),
        ],
        "edges": [{"id": f"e{i}", "source": s, "target": t, **({"sourceHandle": h} if h else {})} for i, (s, t, h) in
                  enumerate([("enquiry", "reception", None), ("reception", "sales", None), ("sales", "pricing", None),
                             ("pricing", "approve", "ok"), ("approve", "email", None), ("email", "crm", None),
                             ("crm", "end", None)])],
    }
    wf = await c.ok("POST", "/workflows", json={"name": "Enquiry to quotation", "draft": draft})
    return wf


async def test_end_to_end_quotation_with_approval():
    c, _ = await signup("Quote Co")
    wf = await _setup_quotation(c)
    v = await c.ok("POST", f"/workflows/{wf['id']}/validate")
    assert v["valid"], v["issues"]
    pub = await c.ok("POST", f"/workflows/{wf['id']}/publish", json={"note": "v1"})
    assert pub["version"] == 1
    run = await c.ok("POST", f"/workflows/{wf['id']}/run",
                     json={"input": {"customer_name": "Ada", "email": "ada@example.com",
                                     "message": "Need 10 chairs"}})
    await drain()
    ex = await c.ok("GET", f"/executions/{run['execution_id']}")
    assert ex["status"] == "awaiting_approval", ex
    appr = (await c.ok("GET", "/approvals"))[0]
    assert appr["payload"]["request"]["to"] == "ada@example.com"
    assert appr["amount"] and appr["amount"] > 0
    # Editing the draft does not change the in-flight execution (bound to version 1).
    await c.ok("PATCH", f"/workflows/{wf['id']}", json={"name": "Renamed"})
    # Decision must reference the exact payload hash that was reviewed.
    await c.ok("POST", f"/approvals/{appr['id']}/decide", expect=409,
               json={"decision": "approve", "payload_hash": "0" * 64})
    await c.ok("POST", f"/approvals/{appr['id']}/decide", json={"decision": "approve",
                                                               "payload_hash": appr["payload_hash"]})
    await drain()
    ex = await c.ok("GET", f"/executions/{run['execution_id']}")
    assert ex["status"] == "completed", ex
    assert {n["node_id"]: n["status"] for n in ex["nodes"]}["email"] == "completed"
    assert float(ex["output"]["total"]) > 0
    outbox = await c.ok("GET", "/outbox")
    assert len(outbox) == 1 and outbox[0]["to"] == "ada@example.com"
    # Re-running the email step cannot send a duplicate (idempotency key per execution+node).
    me = await c.ok("GET", "/auth/me")
    async with tenant_session(me["org"]["id"]) as db:
        email_node = next(n for n in ex["definition"]["nodes"] if n["id"] == "email")
        resp = await execute(db, ToolRequest(
            org_id=uuid.UUID(me["org"]["id"]), execution_id=uuid.UUID(ex["id"]), workflow_id=uuid.UUID(wf["id"]),
            node_id="email", tool="action.send_email", connection_id=uuid.UUID(email_node["data"]["config"]
                                                                               ["connection_id"]),
            request=ex["nodes"][[n["node_id"] for n in ex["nodes"]].index("email")]["output"]["request"],
            require_approval=True, test_mode=False))
        assert resp["deduplicated"] is True
        assert len((await db.scalars(select(SandboxMessage))).all()) == 1
    audit = await c.ok("GET", "/audit")
    actions = {e["action"] for e in audit}
    assert {"workflow.published", "approval.requested", "approval.approved", "tool.action.send_email",
            "execution.completed"} <= actions
    usage = await c.ok("GET", "/analytics/usage")
    assert usage["totals"]["executions"] >= 1
    perf = await c.ok("GET", "/analytics/agents")
    assert any(p["attempted"] >= 1 for p in perf)


async def test_rejection_stops_workflow():
    c, _ = await signup("Reject Co")
    wf = await _setup_quotation(c)
    await c.ok("POST", f"/workflows/{wf['id']}/publish", json={})
    run = await c.ok("POST", f"/workflows/{wf['id']}/run", json={"input": {"email": "bob@example.com"}})
    await drain()
    appr = (await c.ok("GET", "/approvals"))[0]
    await c.ok("POST", f"/approvals/{appr['id']}/decide", expect=422,
               json={"decision": "reject", "payload_hash": appr["payload_hash"]})
    await c.ok("POST", f"/approvals/{appr['id']}/decide",
               json={"decision": "reject", "payload_hash": appr["payload_hash"], "comment": "Too expensive"})
    await drain()
    ex = await c.ok("GET", f"/executions/{run['execution_id']}")
    assert ex["status"] == "rejected"
    assert await c.ok("GET", "/outbox") == []


async def test_gateway_refuses_unapproved_or_changed_actions():
    c, _ = await signup("Gateway Co")
    wf = await _setup_quotation(c)
    await c.ok("POST", f"/workflows/{wf['id']}/publish", json={})
    run = await c.ok("POST", f"/workflows/{wf['id']}/run", json={"input": {"email": "eve@example.com"}})
    await drain()
    me = await c.ok("GET", "/auth/me")
    conn = next(x["id"] for x in await c.ok("GET", "/connections") if x["kind"] == "sandbox_email")
    req = lambda body: ToolRequest(  # noqa: E731
        org_id=uuid.UUID(me["org"]["id"]), execution_id=uuid.UUID(run["execution_id"]),
        workflow_id=uuid.UUID(wf["id"]), node_id="email", tool="action.send_email",
        connection_id=uuid.UUID(conn), request=body, require_approval=True, test_mode=False)
    async with tenant_session(me["org"]["id"]) as db:
        with pytest.raises(GatewayDenied, match="not been approved"):
            await execute(db, req({"to": "eve@example.com", "subject": "x", "body": "y"}))
    appr = (await c.ok("GET", "/approvals"))[0]
    await c.ok("POST", f"/approvals/{appr['id']}/decide", json={"decision": "approve",
                                                               "payload_hash": appr["payload_hash"]})
    async with tenant_session(me["org"]["id"]) as db:
        tampered = {**appr["payload"]["request"], "to": "attacker@evil.test"}
        with pytest.raises(GatewayDenied, match="changed after it was approved"):
            await execute(db, req(tampered))


async def test_validation_messages():
    c, _ = await signup("Validate Co")
    conns = {x["kind"]: x["id"] for x in await c.ok("GET", "/connections")}
    draft = {"nodes": [
        {"id": "t", "type": "trigger.manual", "data": {"config": {}}},
        {"id": "mail", "type": "action.send_email", "data": {"label": "Send", "config": {
            "connection_id": conns["sandbox_email"], "to": "{{ nodes.later.x }}", "subject": "s", "body": "b"}}},
        {"id": "later", "type": "data.transform", "data": {"config": {"mapping": {"x": "1"}}}},
        {"id": "orphan", "type": "control.delay", "data": {"config": {"seconds": 5}}}],
        "edges": [{"id": "1", "source": "t", "target": "mail"}, {"id": "2", "source": "mail", "target": "later"}]}
    wf = await c.ok("POST", "/workflows", json={"name": "Bad", "draft": draft})
    v = await c.ok("POST", f"/workflows/{wf['id']}/validate")
    msgs = " | ".join(i["message"] for i in v["issues"])
    assert not v["valid"]
    assert "needs a human approval" in msgs
    assert "does not run before it" in msgs
    assert "not connected to the trigger" in msgs
    await c.ok("POST", f"/workflows/{wf['id']}/publish", json={}, expect=422)
    draft["edges"].append({"id": "3", "source": "later", "target": "mail"})
    v = await c.ok("POST", f"/workflows/{wf['id']}/validate", json=draft)
    assert any("loop" in i["message"] for i in v["issues"])


async def _single_agent_flow(c: Client, provider_opts: dict | None = None, max_attempts: int = 2,
                             budget: float | None = None):
    prov = await c.ok("POST", "/providers", json={"name": f"P{uuid.uuid4().hex[:4]}", "kind": "sandbox",
                                                  "default_model": "sandbox-1", "options": {},
                                                  "price_in_per_mtok": 1000, "price_out_per_mtok": 1000})
    me = await c.ok("GET", "/auth/me")
    if provider_opts:
        async with tenant_session(me["org"]["id"]) as db:
            await db.execute(text("UPDATE llm_providers SET options = CAST(:o AS jsonb) WHERE id = :i"),
                             {"o": json.dumps(provider_opts), "i": prov["id"]})
            await db.commit()
    ag = await c.ok("POST", "/agents", json={"name": "Solo", "config": {"provider_id": prov["id"],
                                                                        "mode": "limited_autonomy"}})
    await c.ok("POST", f"/agents/{ag['id']}/status", json={"status": "active"})
    if budget is not None:
        await c.ok("PATCH", "/org", json={"monthly_budget_usd": budget})
    draft = {"nodes": [{"id": "t", "type": "trigger.manual", "data": {"config": {}}},
                       {"id": "a", "type": "agent", "data": {"config": {"agent_id": ag["id"], "task": "Summarise",
                                                                        "max_attempts": max_attempts}}}],
             "edges": [{"id": "1", "source": "t", "target": "a"}]}
    wf = await c.ok("POST", "/workflows", json={"name": "Solo", "draft": draft})
    await c.ok("POST", f"/workflows/{wf['id']}/publish", json={})
    return await c.ok("POST", f"/workflows/{wf['id']}/run", json={"input": {"text": "hello"}})


async def test_transient_failures_retry_then_fail():
    c, _ = await signup("Retry Co")
    run = await _single_agent_flow(c, {"fail_mode": "transient"}, max_attempts=2)
    for _ in range(3):
        await drain()
        async with SessionLocal() as db:  # fast-forward the backoff
            await db.execute(update(JobQueue).values(run_after=text("now()")))
            await db.commit()
    ex = await c.ok("GET", f"/executions/{run['execution_id']}")
    assert ex["status"] == "failed" and "after 2 attempts" in ex["error"]
    assert ex["nodes"][-1]["attempt"] == 2


async def test_budget_limit_blocks_model_calls():
    c, _ = await signup("Budget Co")
    run = await _single_agent_flow(c, budget=0)
    await drain()
    ex = await c.ok("GET", f"/executions/{run['execution_id']}")
    assert ex["status"] == "failed" and "budget" in ex["error"].lower()


async def test_cancellation():
    c, _ = await signup("Cancel Co")
    wf = await _setup_quotation(c)
    await c.ok("POST", f"/workflows/{wf['id']}/publish", json={})
    run = await c.ok("POST", f"/workflows/{wf['id']}/run", json={"input": {"email": "c@example.com"}})
    await drain()
    await c.ok("POST", f"/executions/{run['execution_id']}/cancel")
    await drain()
    assert (await c.ok("GET", f"/executions/{run['execution_id']}"))["status"] == "cancelled"


async def test_webhook_requires_valid_signature():
    c, _ = await signup("Hook Co")
    draft = {"nodes": [{"id": "t", "type": "trigger.webhook", "data": {"config": {}}},
                       {"id": "x", "type": "data.transform", "data": {"config": {"mapping": {"n": "{{ trigger.n }}"}}}},
                       {"id": "end", "type": "control.end", "data": {"config": {"result": {"n": "{{ nodes.x.n }}"}}}}],
             "edges": [{"id": "1", "source": "t", "target": "x"}, {"id": "2", "source": "x", "target": "end"}]}
    wf = await c.ok("POST", "/workflows", json={"name": "Hook", "draft": draft})
    pub = await c.ok("POST", f"/workflows/{wf['id']}/publish", json={})
    path, secret = pub["webhook"]["url_path"].removeprefix("/api/v1"), pub["webhook"]["signing_secret"]
    body = json.dumps({"n": 7}).encode()
    anon = Client()
    assert (await anon.post(path, content=body, headers={"x-agentos-signature": "bad"})).status_code == 401
    sig = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    r = await anon.ok("POST", path, content=body, headers={"x-agentos-signature": sig, "idempotency-key": "k1"})
    r2 = await anon.ok("POST", path, content=body, headers={"x-agentos-signature": sig, "idempotency-key": "k1"})
    assert r2["deduplicated"] and r2["execution_id"] == r["execution_id"]
    await drain()
    ex = await c.ok("GET", f"/executions/{r['execution_id']}")
    assert ex["status"] == "completed" and ex["output"] == {"n": 7}


async def test_task_state_machine_and_nl_parsing():
    assert parse_schedule("Every Monday at 9 AM, review overdue invoices")[0] == "0 9 * * 1"
    assert parse_schedule("every weekday at 17:30 send a summary")[0] == "30 17 * * 1-5"
    c, _ = await signup("Task Co")
    ag = await c.ok("POST", "/agents/from-template", json={"template_id": "finance-followup"})
    await c.ok("POST", f"/agents/{ag['id']}/status", json={"status": "active"})
    p = await c.ok("POST", "/tasks/parse", json={"text": "Every Monday at 9 AM, review overdue invoices and "
                                                         "prepare reminder emails."})
    assert p["schedule_cron"] == "0 9 * * 1" and p["agent_id"] == ag["id"] and p["requires_approval"]
    t = await c.ok("POST", "/tasks", json={"title": p["title"], "agent_id": p["agent_id"],
                                           "requires_approval": True, "inputs": {"invoices": [
                                               {"invoice": "INV-1", "customer": "Ada", "amount": 100}]}})
    await c.ok("POST", f"/tasks/{t['id']}/run", expect=409)  # Draft cannot run
    await c.ok("POST", f"/tasks/{t['id']}/transition", json={"to": "Ready"})
    await c.ok("POST", f"/tasks/{t['id']}/run")
    await drain()
    t = await c.ok("GET", f"/tasks/{t['id']}")
    assert t["status"] == "Awaiting Approval", t
    await c.ok("POST", f"/tasks/{t['id']}/review", json={"decision": "accept"})
    t = await c.ok("GET", f"/tasks/{t['id']}")
    assert t["status"] == "Completed"
    assert [e["to"] for e in t["events"]] == ["Draft", "Ready", "Queued", "Running", "Awaiting Approval", "Completed"]
    await c.ok("POST", f"/tasks/{t['id']}/transition", json={"to": "Paused"}, expect=409)


async def test_knowledge_permissions_enforced_in_retrieval():
    a, _ = await signup("KB A")
    b, _ = await signup("KB B")
    kb = await a.ok("POST", "/knowledge/bases", json={"name": "Payroll", "sensitivity": "confidential"})
    await a.ok("POST", f"/knowledge/bases/{kb['id']}/documents",
               files={"file": ("payroll.txt", b"Salary of Ada: 99999 EUR", "text/plain")})
    # Another tenant cannot retrieve it even by id.
    assert await b.ok("POST", "/knowledge/search", json={"query": "salary", "kb_ids": [kb["id"]]}) == []
    # An agent not linked to the knowledge base gets no documents.
    ag = await a.ok("POST", "/agents", json={"name": "Sales", "config": {}})
    out = await a.ok("POST", f"/agents/{ag['id']}/test", json={"task": "What is Ada's salary?", "input": {}})
    assert out["status"] == "completed" and out["output"]["sources"] == []
    assert "99999" not in json.dumps(out["output"]["result"])


async def test_plan_limits_and_sandbox_billing():
    c, _ = await signup("Limits Co")
    for _ in range(5):
        await c.ok("POST", "/agents", json={"name": "A", "config": {}})
    await c.ok("POST", "/agents", json={"name": "A", "config": {}}, expect=402)
    await c.ok("POST", "/billing/checkout", json={"plan": "business"})
    await c.ok("POST", "/agents", json={"name": "A", "config": {}})


async def test_price_check_is_deterministic():
    out = price_check([{"description": "Chair", "quantity": 3, "unit_price": "19.99", "discount_pct": 10},
                       {"description": "Desk", "quantity": 1, "unit_price": 100, "discount_pct": 20}],
                      {"tax_rate_pct": 19, "max_discount_pct": 15})
    assert out["subtotal"] == "159.97" and out["discount_total"] == "26.00"
    assert out["net"] == "133.97" and out["tax"] == "25.45" and out["total"] == "159.42"
    assert not out["ok"] and "exceeds the maximum" in out["violations"][0]
