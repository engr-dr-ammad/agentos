"""Bring-your-own AI model providers and business app connections."""

from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, Literal
from uuid import UUID

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import func, select, update

from ..deps import Admin, Viewer, get_or_404
from ..llm.base import LLMError, Message
from ..llm.service import provider_from_row
from ..models import IntegrationConnection, LLMProvider, Organization, SandboxMessage
from ..plans import limit as plan_limit
from ..security import UnsafeURLError, assert_safe_url, encrypt, secret_hint

router = APIRouter(tags=["integrations"])

ProviderKind = Literal["openai_compatible", "anthropic", "gemini", "sandbox"]

PRESETS = [
    {"id": "openai", "label": "OpenAI", "kind": "openai_compatible", "base_url": "https://api.openai.com/v1",
     "model_hint": "e.g. gpt-4o-mini", "embedding_hint": "text-embedding-3-small"},
    {"id": "anthropic", "label": "Anthropic Claude", "kind": "anthropic", "base_url": "https://api.anthropic.com",
     "model_hint": "e.g. claude-sonnet-4-5"},
    {"id": "gemini", "label": "Google Gemini", "kind": "gemini",
     "base_url": "https://generativelanguage.googleapis.com/v1beta", "model_hint": "e.g. gemini-2.5-flash",
     "embedding_hint": "text-embedding-004"},
    {"id": "azure", "label": "Azure OpenAI", "kind": "openai_compatible",
     "base_url": "https://YOUR-RESOURCE.openai.azure.com/openai/deployments/YOUR-DEPLOYMENT",
     "options": {"auth_header": "api-key", "api_version": "2024-10-21"}, "model_hint": "deployment name"},
    {"id": "mistral", "label": "Mistral", "kind": "openai_compatible", "base_url": "https://api.mistral.ai/v1",
     "model_hint": "e.g. mistral-small-latest"},
    {"id": "groq", "label": "Groq", "kind": "openai_compatible", "base_url": "https://api.groq.com/openai/v1",
     "model_hint": "model id from Groq console"},
    {"id": "deepseek", "label": "DeepSeek", "kind": "openai_compatible", "base_url": "https://api.deepseek.com/v1",
     "model_hint": "e.g. deepseek-chat"},
    {"id": "openrouter", "label": "OpenRouter", "kind": "openai_compatible",
     "base_url": "https://openrouter.ai/api/v1", "model_hint": "e.g. meta-llama/llama-3.1-70b-instruct"},
    {"id": "together", "label": "Together AI", "kind": "openai_compatible",
     "base_url": "https://api.together.xyz/v1", "model_hint": "model id"},
    {"id": "ollama", "label": "Ollama (self-hosted)", "kind": "openai_compatible",
     "base_url": "http://host.docker.internal:11434/v1", "model_hint": "e.g. llama3.1", "no_key": True},
    {"id": "vllm", "label": "vLLM / LM Studio / other OpenAI-compatible", "kind": "openai_compatible",
     "base_url": "http://localhost:8001/v1", "model_hint": "served model name", "no_key": True},
]


@router.get("/providers/presets")
async def presets(ctx: Viewer):
    return PRESETS


class ProviderIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    kind: ProviderKind
    base_url: str | None = Field(None, max_length=500)
    api_key: str | None = Field(None, max_length=4000)
    default_model: str = Field(min_length=1, max_length=200)
    embedding_model: str | None = None
    options: dict[str, Any] = {}
    price_in_per_mtok: Decimal = Field(Decimal(0), ge=0)
    price_out_per_mtok: Decimal = Field(Decimal(0), ge=0)
    is_default: bool = False
    privacy_tier: Literal["external", "self_hosted", "eu_only"] = "external"

    @model_validator(mode="after")
    def _check(self):
        allowed = {"auth_header", "api_version", "headers", "no_json_mode"}
        if set(self.options) - allowed:
            raise ValueError(f"Unsupported options: {set(self.options) - allowed}")
        if self.base_url:
            try:
                assert_safe_url(self.base_url)
            except UnsafeURLError as e:
                raise ValueError(str(e)) from e
        return self


class ProviderPatch(BaseModel):
    name: str | None = None
    base_url: str | None = None
    api_key: str | None = None
    default_model: str | None = None
    embedding_model: str | None = None
    options: dict[str, Any] | None = None
    price_in_per_mtok: Decimal | None = Field(None, ge=0)
    price_out_per_mtok: Decimal | None = Field(None, ge=0)
    is_default: bool | None = None
    privacy_tier: Literal["external", "self_hosted", "eu_only"] | None = None


def provider_out(p: LLMProvider) -> dict:
    # The API key is never returned — only a short hint.
    return {"id": p.id, "name": p.name, "kind": p.kind, "base_url": p.base_url, "api_key_hint": p.api_key_hint,
            "has_key": p.api_key_enc is not None, "default_model": p.default_model,
            "embedding_model": p.embedding_model, "options": p.options, "is_default": p.is_default,
            "price_in_per_mtok": p.price_in_per_mtok, "price_out_per_mtok": p.price_out_per_mtok,
            "privacy_tier": p.privacy_tier, "last_tested_at": p.last_tested_at, "last_test_ok": p.last_test_ok}


@router.get("/providers")
async def list_providers(ctx: Viewer):
    rows = (await ctx.db.scalars(select(LLMProvider).where(LLMProvider.org_id == ctx.org_id)
                                 .order_by(LLMProvider.is_default.desc(), LLMProvider.name))).all()
    return [provider_out(p) for p in rows]


async def _make_default(ctx, pid: UUID) -> None:
    await ctx.db.execute(update(LLMProvider).where(LLMProvider.org_id == ctx.org_id, LLMProvider.id != pid)
                         .values(is_default=False))


@router.post("/providers", status_code=201)
async def create_provider(body: ProviderIn, ctx: Admin):
    if await ctx.db.scalar(select(LLMProvider.id).where(LLMProvider.org_id == ctx.org_id,
                                                        LLMProvider.name == body.name)):
        raise HTTPException(409, "A model connection with this name already exists")
    p = LLMProvider(org_id=ctx.org_id, **body.model_dump(exclude={"api_key"}))
    if body.api_key:
        p.api_key_enc, p.api_key_hint = encrypt(body.api_key.strip()), secret_hint(body.api_key.strip())
    ctx.db.add(p)
    await ctx.db.flush()
    if body.is_default:
        await _make_default(ctx, p.id)
    await ctx.audit("provider.created", "llm_provider", p.id, kind=p.kind, name=p.name)
    await ctx.db.commit()
    return provider_out(p)


@router.patch("/providers/{pid}")
async def update_provider(pid: UUID, body: ProviderPatch, ctx: Admin):
    p = await get_or_404(ctx.db, LLMProvider, pid, ctx.org_id, "Model connection")
    data = body.model_dump(exclude_unset=True)
    if "base_url" in data and data["base_url"]:
        try:
            assert_safe_url(data["base_url"])
        except UnsafeURLError as e:
            raise HTTPException(422, str(e)) from e
    if key := data.pop("api_key", None):
        p.api_key_enc, p.api_key_hint = encrypt(key.strip()), secret_hint(key.strip())
    for k, v in data.items():
        setattr(p, k, v)
    if data.get("is_default"):
        await _make_default(ctx, p.id)
    await ctx.audit("provider.updated", "llm_provider", p.id, fields=list(body.model_dump(exclude_unset=True)))
    await ctx.db.commit()
    return provider_out(p)


@router.delete("/providers/{pid}")
async def delete_provider(pid: UUID, ctx: Admin):
    p = await get_or_404(ctx.db, LLMProvider, pid, ctx.org_id, "Model connection")
    await ctx.db.delete(p)
    await ctx.audit("provider.deleted", "llm_provider", pid, name=p.name)
    await ctx.db.commit()
    return {"ok": True}


@router.post("/providers/{pid}/test")
async def test_provider(pid: UUID, ctx: Admin):
    p = await get_or_404(ctx.db, LLMProvider, pid, ctx.org_id, "Model connection")
    try:
        res = await provider_from_row(p).complete(
            [Message("system", "You are a connectivity check."), Message("user", "Reply with the word OK.")],
            p.default_model, max_tokens=20, temperature=0)
        ok, detail = True, res.text.strip()[:100]
    except LLMError as e:
        ok, detail = False, str(e)[:500]
    p.last_tested_at, p.last_test_ok = datetime.now(UTC), ok
    await ctx.db.commit()
    return {"ok": ok, "detail": detail}


@router.get("/providers/{pid}/models")
async def provider_models(pid: UUID, ctx: Admin):
    p = await get_or_404(ctx.db, LLMProvider, pid, ctx.org_id, "Model connection")
    try:
        return {"models": (await provider_from_row(p).list_models())[:300]}
    except LLMError as e:
        raise HTTPException(502, str(e)) from e


# ================================================================== app connections
ConnKind = Literal["sandbox_email", "smtp", "sandbox_crm", "http_api"]

CONNECTION_TYPES = {
    "sandbox_email": {"label": "Sandbox email", "secret": None, "fields": [],
                      "description": "Stores messages in the AgentOS outbox. Nothing is delivered."},
    "smtp": {"label": "Email (SMTP)", "secret": "SMTP password",
             "fields": ["host", "port", "username", "from_address", "starttls"],
             "description": "Send real email through your mail server (works with Gmail, Outlook/M365, etc.)."},
    "sandbox_crm": {"label": "Built-in CRM", "secret": None, "fields": [],
                    "description": "A simple customer record store inside AgentOS."},
    "http_api": {"label": "REST API", "secret": "Auth header value (e.g. 'Bearer …')",
                 "fields": ["base_url", "auth_header"],
                 "description": "Call an approved HTTP API. Requests are locked to this host."},
}
PLANNED = ["Gmail (OAuth)", "Microsoft Outlook (OAuth)", "Google Calendar", "Microsoft Calendar", "Google Drive",
           "OneDrive", "Slack", "Microsoft Teams", "HubSpot", "Shopify", "Stripe"]


@router.get("/connections/types")
async def connection_types(ctx: Viewer):
    return {"available": CONNECTION_TYPES, "planned": PLANNED}


class ConnIn(BaseModel):
    kind: ConnKind
    name: str = Field(min_length=1, max_length=160)
    config: dict[str, Any] = {}
    secret: str | None = Field(None, max_length=4000)
    allowed_workflow_ids: list[str] | None = None
    rate_limit_per_minute: int = Field(30, ge=1, le=10_000)

    @model_validator(mode="after")
    def _check(self):
        spec = CONNECTION_TYPES[self.kind]
        unknown = set(self.config) - set(spec["fields"]) - {"note"}
        if unknown:
            raise ValueError(f"Unknown settings: {', '.join(unknown)}")
        if self.kind == "smtp":
            for f in ("host", "from_address"):
                if not self.config.get(f):
                    raise ValueError(f"'{f}' is required for SMTP")
        if self.kind == "http_api":
            try:
                assert_safe_url(self.config.get("base_url") or "")
            except UnsafeURLError as e:
                raise ValueError(f"base_url: {e}") from e
        return self


class ConnPatch(BaseModel):
    name: str | None = None
    config: dict[str, Any] | None = None
    secret: str | None = None
    allowed_workflow_ids: list[str] | None = None
    restrict_workflows: bool | None = None
    rate_limit_per_minute: int | None = Field(None, ge=1, le=10_000)
    status: Literal["active", "revoked"] | None = None


def conn_out(c: IntegrationConnection) -> dict:
    return {"id": c.id, "kind": c.kind, "name": c.name, "config": c.config, "has_secret": c.secret_enc is not None,
            "allowed_workflow_ids": c.allowed_workflow_ids, "rate_limit_per_minute": c.rate_limit_per_minute,
            "status": c.status, "label": CONNECTION_TYPES[c.kind]["label"], "last_tested_at": c.last_tested_at,
            "last_test_ok": c.last_test_ok, "created_at": c.created_at}


@router.get("/connections")
async def list_connections(ctx: Viewer):
    rows = (await ctx.db.scalars(select(IntegrationConnection).where(IntegrationConnection.org_id == ctx.org_id)
                                 .order_by(IntegrationConnection.name))).all()
    return [conn_out(c) for c in rows]


@router.post("/connections", status_code=201)
async def create_connection(body: ConnIn, ctx: Admin):
    org = await ctx.db.get(Organization, ctx.org_id)
    cap = plan_limit(org.plan, "integrations")
    n = await ctx.db.scalar(select(func.count()).select_from(IntegrationConnection)
                            .where(IntegrationConnection.org_id == ctx.org_id))
    if cap is not None and n >= cap:
        raise HTTPException(402, f"Your plan allows {cap} connections. Upgrade under Billing.")
    c = IntegrationConnection(org_id=ctx.org_id, kind=body.kind, name=body.name, config=body.config,
                              allowed_workflow_ids=body.allowed_workflow_ids,
                              rate_limit_per_minute=body.rate_limit_per_minute,
                              secret_enc=encrypt(body.secret) if body.secret else None)
    ctx.db.add(c)
    await ctx.db.flush()
    await ctx.audit("connection.created", "connection", c.id, kind=c.kind, name=c.name)
    await ctx.db.commit()
    return conn_out(c)


@router.patch("/connections/{cid}")
async def update_connection(cid: UUID, body: ConnPatch, ctx: Admin):
    c = await get_or_404(ctx.db, IntegrationConnection, cid, ctx.org_id, "Connection")
    data = body.model_dump(exclude_unset=True)
    if data.get("secret"):
        c.secret_enc = encrypt(data.pop("secret"))  # rotation
    data.pop("secret", None)
    if data.pop("restrict_workflows", None) is False:
        c.allowed_workflow_ids = None
        data.pop("allowed_workflow_ids", None)
    if "config" in data:
        ConnIn(kind=c.kind, name=c.name, config=data["config"])  # re-validate
    for k, v in data.items():
        setattr(c, k, v)
    await ctx.audit("connection.updated", "connection", c.id, fields=list(body.model_dump(exclude_unset=True)))
    await ctx.db.commit()
    return conn_out(c)


@router.delete("/connections/{cid}")
async def delete_connection(cid: UUID, ctx: Admin):
    c = await get_or_404(ctx.db, IntegrationConnection, cid, ctx.org_id, "Connection")
    await ctx.db.delete(c)
    await ctx.audit("connection.deleted", "connection", cid, name=c.name)
    await ctx.db.commit()
    return {"ok": True}


@router.post("/connections/{cid}/test")
async def test_connection(cid: UUID, ctx: Admin):
    c = await get_or_404(ctx.db, IntegrationConnection, cid, ctx.org_id, "Connection")
    ok, detail = True, "Sandbox connection is ready"
    if c.kind == "smtp":
        import aiosmtplib

        from ..security import decrypt

        try:
            smtp = aiosmtplib.SMTP(hostname=c.config["host"], port=int(c.config.get("port", 587)),
                                   start_tls=bool(c.config.get("starttls", True)), timeout=15)
            await smtp.connect()
            if c.config.get("username"):
                await smtp.login(c.config["username"], decrypt(c.secret_enc) or "")
            await smtp.quit()
            detail = "Connected and authenticated"
        except Exception as e:
            ok, detail = False, f"SMTP check failed: {e}"[:300]
    elif c.kind == "http_api":
        from ..llm.base import http

        try:
            assert_safe_url(c.config["base_url"])
            r = await http().head(c.config["base_url"], timeout=10)
            detail = f"Host reachable (HTTP {r.status_code})"
        except Exception as e:
            ok, detail = False, f"Host not reachable: {e}"[:300]
    c.last_tested_at, c.last_test_ok = datetime.now(UTC), ok
    await ctx.db.commit()
    return {"ok": ok, "detail": detail}


@router.get("/outbox")
async def sandbox_outbox(ctx: Viewer, limit: int = 50):
    rows = (await ctx.db.scalars(select(SandboxMessage).where(SandboxMessage.org_id == ctx.org_id)
                                 .order_by(SandboxMessage.created_at.desc()).limit(min(limit, 200)))).all()
    return [{"id": m.id, "to": m.to, "subject": m.subject, "body": m.body, "execution_id": m.execution_id,
             "created_at": m.created_at} for m in rows]
