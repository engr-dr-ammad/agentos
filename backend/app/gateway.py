"""Server-side tool gateway — the only path to external side effects.

A model-generated or workflow-generated action is a *request*. The gateway checks tenant, connection
status and scope, approval binding (exact payload hash), rate limits and idempotency before anything
leaves the platform. Secrets are decrypted here and never reach the browser or a model.
"""

import json
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from email.message import EmailMessage
from typing import Any
from urllib.parse import urljoin, urlparse
from uuid import UUID

import httpx
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from .deps import audit
from .llm.base import http
from .models import Approval, CrmRecord, IntegrationConnection, SandboxMessage, ToolCall
from .security import UnsafeURLError, assert_safe_url, canonical_hash, decrypt

TOOL_KINDS = {
    "action.send_email": {"sandbox_email", "smtp"},
    "action.crm_upsert": {"sandbox_crm"},
    "action.http_request": {"http_api"},
}
SANDBOX_KINDS = {"sandbox_email", "sandbox_crm"}


class GatewayDenied(Exception):
    """Permanent refusal (permission, approval, configuration)."""


class GatewayRetry(Exception):
    """Temporary refusal (rate limit, upstream outage)."""


@dataclass(slots=True)
class ToolRequest:
    org_id: UUID
    execution_id: UUID
    workflow_id: UUID | None
    node_id: str
    tool: str
    connection_id: UUID
    request: dict[str, Any]
    require_approval: bool
    test_mode: bool


def approval_payload(tool: str, request: dict) -> dict:
    return {"action": tool, "request": request}


async def execute(db: AsyncSession, r: ToolRequest) -> dict[str, Any]:
    conn = await db.get(IntegrationConnection, r.connection_id)
    if conn is None or conn.org_id != r.org_id:
        raise GatewayDenied("Connection not found")
    if conn.status != "active":
        raise GatewayDenied(f"Connection '{conn.name}' is revoked")
    if conn.kind not in TOOL_KINDS.get(r.tool, set()):
        raise GatewayDenied(f"Connection '{conn.name}' cannot perform {r.tool}")
    if conn.allowed_workflow_ids is not None and str(r.workflow_id) not in conn.allowed_workflow_ids:
        raise GatewayDenied(f"This workflow is not authorised to use '{conn.name}'")

    req_hash = canonical_hash(approval_payload(r.tool, r.request))
    if r.require_approval:
        appr = await db.scalar(select(Approval).where(
            Approval.execution_id == r.execution_id, Approval.action_node_id == r.node_id))
        if appr is None or appr.status != "approved":
            raise GatewayDenied("This action has not been approved")
        if appr.payload_hash != req_hash:
            raise GatewayDenied("The action changed after it was approved; fresh approval is required")

    key = f"{r.execution_id}:{r.node_id}"
    existing = await db.scalar(select(ToolCall).where(ToolCall.idempotency_key == key))
    if existing is not None:
        if existing.status == "succeeded":
            return {**(existing.response or {}), "deduplicated": True}
        if existing.status in ("pending", "unknown") and not existing.sandbox:
            existing.status = "unknown"
            await db.commit()
            raise GatewayDenied("A previous attempt may already have performed this action. "
                                "Check the destination system before re-running.")
        await db.delete(existing)  # failed or sandbox → safe to retry
        await db.flush()

    recent = await db.scalar(select(func.count()).select_from(ToolCall).where(
        ToolCall.connection_id == conn.id, ToolCall.created_at > datetime.now(UTC) - timedelta(minutes=1)))
    if recent >= conn.rate_limit_per_minute:
        raise GatewayRetry(f"Rate limit for '{conn.name}' reached")

    sandbox = r.test_mode or conn.kind in SANDBOX_KINDS
    call = ToolCall(org_id=r.org_id, execution_id=r.execution_id, node_id=r.node_id, connection_id=conn.id,
                    tool=r.tool, idempotency_key=key, request_hash=req_hash, request=r.request,
                    status="pending", sandbox=sandbox)
    db.add(call)
    await db.commit()  # record intent before the side effect (at-most-once)

    try:
        response = await _perform(db, conn, r, sandbox)
    except GatewayRetry:
        call.status = "failed"
        await db.commit()
        raise
    except Exception as e:
        call.status = "failed"
        call.response = {"error": str(e)[:500]}
        await db.commit()
        raise GatewayDenied(str(e)) from e
    call.status, call.response = "succeeded", response
    await audit(db, r.org_id, f"tool.{r.tool}", "connection", conn.id,
                {"execution_id": str(r.execution_id), "node_id": r.node_id, "sandbox": sandbox},
                actor_type="system", actor_label="tool-gateway")
    await db.commit()
    return response


async def _perform(db: AsyncSession, conn: IntegrationConnection, r: ToolRequest, sandbox: bool) -> dict:
    req = r.request
    if r.tool == "action.send_email":
        if sandbox:
            msg = SandboxMessage(org_id=r.org_id, connection_id=conn.id, execution_id=r.execution_id,
                                 to=str(req["to"])[:320], subject=str(req["subject"])[:500], body=str(req["body"]))
            db.add(msg)
            await db.flush()
            return {"delivered": False, "sandbox": True, "sandbox_message_id": str(msg.id),
                    "note": "Sandbox: stored in the AgentOS outbox, not delivered."}
        return await _smtp_send(conn, req)
    if r.tool == "action.crm_upsert":
        stmt = insert(CrmRecord).values(org_id=r.org_id, external_key=str(req["key"])[:320], data=req["fields"])
        stmt = stmt.on_conflict_do_update(index_elements=["org_id", "external_key"],
                                          set_={"data": CrmRecord.data.op("||")(stmt.excluded.data),
                                                "updated_at": func.now()})
        await db.execute(stmt)
        return {"upserted": True, "key": req["key"], "sandbox": True}
    if r.tool == "action.http_request":
        if sandbox:
            return {"sandbox": True, "status": 200, "note": "Sandbox: request not sent", "request": req}
        return await _http_call(conn, req)
    raise GatewayDenied(f"Unknown tool {r.tool}")


async def _smtp_send(conn: IntegrationConnection, req: dict) -> dict:
    import aiosmtplib

    cfg = conn.config
    msg = EmailMessage()
    msg["From"] = cfg["from_address"]
    msg["To"] = req["to"]
    msg["Subject"] = req["subject"]
    msg.set_content(req["body"])
    try:
        await aiosmtplib.send(msg, hostname=cfg["host"], port=int(cfg.get("port", 587)),
                              username=cfg.get("username") or None, password=decrypt(conn.secret_enc),
                              start_tls=bool(cfg.get("starttls", True)), timeout=30)
    except (aiosmtplib.SMTPConnectError, aiosmtplib.SMTPServerDisconnected, TimeoutError) as e:
        raise GatewayRetry(f"Mail server unavailable: {e}") from e
    return {"delivered": True, "sandbox": False, "to": req["to"]}


async def _http_call(conn: IntegrationConnection, req: dict) -> dict:
    base = conn.config["base_url"].rstrip("/") + "/"
    path = str(req.get("path") or "").lstrip("/")
    url = urljoin(base, path)
    if urlparse(url).netloc != urlparse(base).netloc or ".." in path:
        raise GatewayDenied("Path must stay on the connection's host")
    try:
        assert_safe_url(url)
    except UnsafeURLError as e:
        raise GatewayDenied(str(e)) from e
    headers = {"content-type": "application/json"}
    if conn.secret_enc and conn.config.get("auth_header"):
        headers[conn.config["auth_header"]] = decrypt(conn.secret_enc)
    body = req.get("body")
    if isinstance(body, str) and body.strip():
        try:
            body = json.loads(body)
        except ValueError as e:
            raise GatewayDenied("Request body must be valid JSON") from e
    try:
        resp = await http().request(req.get("method", "POST"), url, headers=headers,
                                    json=body if body not in (None, "") else None, timeout=30)
    except (httpx.TimeoutException, httpx.NetworkError) as e:
        raise GatewayRetry(f"API unreachable: {e.__class__.__name__}") from e
    if resp.status_code == 429 or resp.status_code >= 500:
        raise GatewayRetry(f"API returned {resp.status_code}")
    try:
        data: Any = resp.json()
    except ValueError:
        data = resp.text[:5000]
    if resp.status_code >= 400:
        raise GatewayDenied(f"API returned {resp.status_code}: {str(data)[:300]}")
    return {"status": resp.status_code, "body": data, "sandbox": False}
