import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    BigInteger,
    Boolean,
    Computed,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, TSVECTOR, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

JSON = JSONB
Money = Numeric(14, 6)


class Base(DeclarativeBase):
    # Fetch server-generated values (defaults, onupdate) via RETURNING so async code never lazy-loads.
    __mapper_args__ = {"eager_defaults": True}
    type_annotation_map = {dict[str, Any]: JSONB, list[Any]: JSONB, uuid.UUID: UUID(as_uuid=True)}


def pk() -> Mapped[uuid.UUID]:
    return mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)


def created() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


def org_fk() -> Mapped[uuid.UUID]:
    return mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True, nullable=False)


# Tables carrying a row-level-security policy on org_id (see migration 0001).
RLS_TABLES: list[str] = []


def rls(cls):
    RLS_TABLES.append(cls.__tablename__)
    return cls


# ---------------------------------------------------------------- identity / orgs
class Organization(Base):
    __tablename__ = "organizations"
    id: Mapped[uuid.UUID] = pk()
    name: Mapped[str] = mapped_column(String(200))
    slug: Mapped[str] = mapped_column(String(80), unique=True)
    industry: Mapped[str | None] = mapped_column(String(80))
    size: Mapped[str | None] = mapped_column(String(40))
    country: Mapped[str | None] = mapped_column(String(80))
    language: Mapped[str] = mapped_column(String(16), default="en")
    timezone: Mapped[str] = mapped_column(String(64), default="UTC")
    objective: Mapped[str | None] = mapped_column(Text)
    website: Mapped[str | None] = mapped_column(String(300))
    plan: Mapped[str] = mapped_column(String(32), default="starter")
    monthly_budget_usd: Mapped[Decimal | None] = mapped_column(Money)
    retention_days: Mapped[int] = mapped_column(Integer, default=365)
    data_region: Mapped[str] = mapped_column(String(32), default="eu")
    onboarded: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = created()


class User(Base):
    __tablename__ = "users"
    id: Mapped[uuid.UUID] = pk()
    email: Mapped[str] = mapped_column(String(320), unique=True)
    name: Mapped[str] = mapped_column(String(200))
    password_hash: Mapped[str] = mapped_column(String(300))
    mfa_secret_enc: Mapped[bytes | None] = mapped_column(LargeBinary)
    mfa_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    is_platform_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    session_version: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = created()


class Membership(Base):
    __tablename__ = "memberships"
    __table_args__ = (UniqueConstraint("org_id", "user_id"),)
    id: Mapped[uuid.UUID] = pk()
    org_id: Mapped[uuid.UUID] = org_fk()
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(32))
    department: Mapped[str | None] = mapped_column(String(120))
    created_at: Mapped[datetime] = created()


class Invitation(Base):
    __tablename__ = "invitations"
    id: Mapped[uuid.UUID] = pk()
    org_id: Mapped[uuid.UUID] = org_fk()
    email: Mapped[str] = mapped_column(String(320))
    role: Mapped[str] = mapped_column(String(32))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    invited_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = created()


@rls
class Department(Base):
    __tablename__ = "departments"
    __table_args__ = (UniqueConstraint("org_id", "name"),)
    id: Mapped[uuid.UUID] = pk()
    org_id: Mapped[uuid.UUID] = org_fk()
    name: Mapped[str] = mapped_column(String(120))
    created_at: Mapped[datetime] = created()


# ---------------------------------------------------------------- models / providers
@rls
class LLMProvider(Base):
    __tablename__ = "llm_providers"
    __table_args__ = (UniqueConstraint("org_id", "name"),)
    id: Mapped[uuid.UUID] = pk()
    org_id: Mapped[uuid.UUID] = org_fk()
    name: Mapped[str] = mapped_column(String(120))
    kind: Mapped[str] = mapped_column(String(32))  # openai_compatible | anthropic | gemini | sandbox
    base_url: Mapped[str | None] = mapped_column(String(500))
    api_key_enc: Mapped[bytes | None] = mapped_column(LargeBinary)
    api_key_hint: Mapped[str | None] = mapped_column(String(12))
    options: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # auth_header, api_version, headers
    default_model: Mapped[str] = mapped_column(String(200))
    embedding_model: Mapped[str | None] = mapped_column(String(200))
    price_in_per_mtok: Mapped[Decimal] = mapped_column(Money, default=0)
    price_out_per_mtok: Mapped[Decimal] = mapped_column(Money, default=0)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    privacy_tier: Mapped[str] = mapped_column(String(32), default="external")  # external | self_hosted | eu_only
    last_tested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_test_ok: Mapped[bool | None] = mapped_column(Boolean)
    created_at: Mapped[datetime] = created()


# ---------------------------------------------------------------- agents
@rls
class Agent(Base):
    __tablename__ = "agents"
    id: Mapped[uuid.UUID] = pk()
    org_id: Mapped[uuid.UUID] = org_fk()
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(Text, default="")
    department: Mapped[str | None] = mapped_column(String(120))
    owner_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    escalation_contact: Mapped[str | None] = mapped_column(String(320))
    template_id: Mapped[str | None] = mapped_column(String(80))
    status: Mapped[str] = mapped_column(String(16), default="draft")  # draft | active | paused | disabled
    current_version: Mapped[int] = mapped_column(Integer, default=1)
    monthly_budget_usd: Mapped[Decimal | None] = mapped_column(Money)
    created_at: Mapped[datetime] = created()
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


@rls
class AgentVersion(Base):
    __tablename__ = "agent_versions"
    __table_args__ = (UniqueConstraint("agent_id", "version"),)
    id: Mapped[uuid.UUID] = pk()
    org_id: Mapped[uuid.UUID] = org_fk()
    agent_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("agents.id", ondelete="CASCADE"), index=True)
    version: Mapped[int] = mapped_column(Integer)
    config: Mapped[dict[str, Any]] = mapped_column(JSON)
    note: Mapped[str | None] = mapped_column(String(300))
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = created()


# ---------------------------------------------------------------- workflows
@rls
class Workflow(Base):
    __tablename__ = "workflows"
    id: Mapped[uuid.UUID] = pk()
    org_id: Mapped[uuid.UUID] = org_fk()
    name: Mapped[str] = mapped_column(String(160))
    description: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(16), default="draft")  # draft | active | paused
    draft: Mapped[dict[str, Any]] = mapped_column(JSON, default=lambda: {"nodes": [], "edges": []})
    published_version: Mapped[int | None] = mapped_column(Integer)
    monthly_budget_usd: Mapped[Decimal | None] = mapped_column(Money)
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = created()
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


@rls
class WorkflowVersion(Base):
    """Immutable published definition. Executions reference (workflow_id, version)."""

    __tablename__ = "workflow_versions"
    __table_args__ = (UniqueConstraint("workflow_id", "version"),)
    id: Mapped[uuid.UUID] = pk()
    org_id: Mapped[uuid.UUID] = org_fk()
    workflow_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("workflows.id", ondelete="CASCADE"), index=True)
    version: Mapped[int] = mapped_column(Integer)
    definition: Mapped[dict[str, Any]] = mapped_column(JSON)
    note: Mapped[str | None] = mapped_column(String(300))
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = created()


@rls
class WorkflowExecution(Base):
    __tablename__ = "workflow_executions"
    __table_args__ = (Index("ix_exec_org_created", "org_id", "created_at"),)
    id: Mapped[uuid.UUID] = pk()
    org_id: Mapped[uuid.UUID] = org_fk()
    workflow_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("workflows.id", ondelete="CASCADE"), index=True)
    version: Mapped[int] = mapped_column(Integer)  # 0 = draft/ad-hoc run (definition snapshot stored)
    definition: Mapped[dict[str, Any] | None] = mapped_column(JSON)  # snapshot for draft test runs
    mode: Mapped[str] = mapped_column(String(16), default="production")  # test | production
    status: Mapped[str] = mapped_column(String(24), default="queued")
    trigger_type: Mapped[str] = mapped_column(String(24), default="manual")
    input: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    output: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    error: Mapped[str | None] = mapped_column(Text)
    cost_usd: Mapped[Decimal] = mapped_column(Money, default=0)
    cancel_requested: Mapped[bool] = mapped_column(Boolean, default=False)
    task_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("tasks.id", ondelete="SET NULL"))
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = created()
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


@rls
class NodeExecution(Base):
    __tablename__ = "node_executions"
    __table_args__ = (UniqueConstraint("execution_id", "node_id"),)
    id: Mapped[uuid.UUID] = pk()
    org_id: Mapped[uuid.UUID] = org_fk()
    execution_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workflow_executions.id", ondelete="CASCADE"), index=True
    )
    node_id: Mapped[str] = mapped_column(String(64))
    node_type: Mapped[str] = mapped_column(String(48))
    status: Mapped[str] = mapped_column(String(24))
    attempt: Mapped[int] = mapped_column(Integer, default=0)
    input: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    output: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    error: Mapped[str | None] = mapped_column(Text)
    cost_usd: Mapped[Decimal] = mapped_column(Money, default=0)
    tokens_in: Mapped[int] = mapped_column(Integer, default=0)
    tokens_out: Mapped[int] = mapped_column(Integer, default=0)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class JobQueue(Base):
    """Cross-tenant work queue (no sensitive data, no RLS). Claimed with SKIP LOCKED."""

    __tablename__ = "job_queue"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    execution_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workflow_executions.id", ondelete="CASCADE"), unique=True
    )
    org_id: Mapped[uuid.UUID] = org_fk()
    run_after: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    attempts: Mapped[int] = mapped_column(Integer, default=0)


class Schedule(Base):
    __tablename__ = "schedules"
    id: Mapped[uuid.UUID] = pk()
    org_id: Mapped[uuid.UUID] = org_fk()
    workflow_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("workflows.id", ondelete="CASCADE"), unique=True
    )
    task_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("tasks.id", ondelete="CASCADE"), unique=True)
    cron: Mapped[str] = mapped_column(String(120))
    timezone: Mapped[str] = mapped_column(String(64), default="UTC")
    next_run_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)


class WebhookEndpoint(Base):
    __tablename__ = "webhook_endpoints"
    id: Mapped[uuid.UUID] = pk()
    org_id: Mapped[uuid.UUID] = org_fk()
    workflow_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("workflows.id", ondelete="CASCADE"), unique=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    secret_enc: Mapped[bytes] = mapped_column(LargeBinary)
    created_at: Mapped[datetime] = created()


# ---------------------------------------------------------------- approvals / tasks
@rls
class Approval(Base):
    __tablename__ = "approvals"
    __table_args__ = (
        UniqueConstraint("execution_id", "node_id"),
        Index("ix_approvals_org_status", "org_id", "status"),
    )
    id: Mapped[uuid.UUID] = pk()
    org_id: Mapped[uuid.UUID] = org_fk()
    execution_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("workflow_executions.id", ondelete="CASCADE"))
    workflow_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("workflows.id", ondelete="CASCADE"))
    workflow_version: Mapped[int] = mapped_column(Integer)
    node_id: Mapped[str] = mapped_column(String(64))
    action_node_id: Mapped[str | None] = mapped_column(String(64))
    title: Mapped[str] = mapped_column(String(300))
    reason: Mapped[str] = mapped_column(Text, default="")
    risks: Mapped[str] = mapped_column(Text, default="")
    payload: Mapped[dict[str, Any]] = mapped_column(JSON)
    payload_hash: Mapped[str] = mapped_column(String(64))
    amount: Mapped[Decimal | None] = mapped_column(Money)
    currency: Mapped[str | None] = mapped_column(String(8))
    evidence: Mapped[list[Any]] = mapped_column(JSON, default=list)
    approver_role: Mapped[str] = mapped_column(String(32), default="manager")
    requested_by_agent: Mapped[str | None] = mapped_column(String(160))
    delegated_to: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    status: Mapped[str] = mapped_column(String(24), default="pending")
    decided_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    comment: Mapped[str | None] = mapped_column(Text)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = created()


@rls
class Task(Base):
    __tablename__ = "tasks"
    id: Mapped[uuid.UUID] = pk()
    org_id: Mapped[uuid.UUID] = org_fk()
    title: Mapped[str] = mapped_column(String(300))
    description: Mapped[str] = mapped_column(Text, default="")
    agent_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("agents.id", ondelete="SET NULL"), index=True)
    workflow_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("workflows.id", ondelete="SET NULL"))
    owner_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    priority: Mapped[str] = mapped_column(String(16), default="normal")
    status: Mapped[str] = mapped_column(String(24), default="draft")
    due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    schedule_cron: Mapped[str | None] = mapped_column(String(120))
    inputs: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    expected_output: Mapped[str | None] = mapped_column(Text)
    requires_approval: Mapped[bool] = mapped_column(Boolean, default=True)
    dependencies: Mapped[list[Any]] = mapped_column(JSON, default=list)
    result: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    cost_usd: Mapped[Decimal] = mapped_column(Money, default=0)
    error: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = created()
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


@rls
class TaskEvent(Base):
    __tablename__ = "task_events"
    id: Mapped[uuid.UUID] = pk()
    org_id: Mapped[uuid.UUID] = org_fk()
    task_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("tasks.id", ondelete="CASCADE"), index=True)
    from_status: Mapped[str | None] = mapped_column(String(24))
    to_status: Mapped[str] = mapped_column(String(24))
    actor_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = created()


# ---------------------------------------------------------------- knowledge
@rls
class KnowledgeBase(Base):
    __tablename__ = "knowledge_bases"
    __table_args__ = (UniqueConstraint("org_id", "name"),)
    id: Mapped[uuid.UUID] = pk()
    org_id: Mapped[uuid.UUID] = org_fk()
    name: Mapped[str] = mapped_column(String(160))
    description: Mapped[str] = mapped_column(Text, default="")
    sensitivity: Mapped[str] = mapped_column(String(24), default="internal")  # public|internal|confidential
    embedding_provider_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("llm_providers.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = created()


@rls
class Document(Base):
    __tablename__ = "documents"
    id: Mapped[uuid.UUID] = pk()
    org_id: Mapped[uuid.UUID] = org_fk()
    kb_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("knowledge_bases.id", ondelete="CASCADE"), index=True)
    filename: Mapped[str] = mapped_column(String(300))
    mime: Mapped[str] = mapped_column(String(120))
    size_bytes: Mapped[int] = mapped_column(Integer)
    sha256: Mapped[str] = mapped_column(String(64))
    version: Mapped[int] = mapped_column(Integer, default=1)
    status: Mapped[str] = mapped_column(String(16), default="indexed")
    chunk_count: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text)
    uploaded_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = created()


@rls
class DocumentChunk(Base):
    __tablename__ = "document_chunks"
    __table_args__ = (Index("ix_chunks_tsv", "tsv", postgresql_using="gin"),)
    id: Mapped[uuid.UUID] = pk()
    org_id: Mapped[uuid.UUID] = org_fk()
    kb_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("knowledge_bases.id", ondelete="CASCADE"), index=True)
    document_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"), index=True)
    idx: Mapped[int] = mapped_column(Integer)
    content: Mapped[str] = mapped_column(Text)
    tsv: Mapped[Any] = mapped_column(TSVECTOR, Computed("to_tsvector('simple', content)", persisted=True))
    embedding: Mapped[Any | None] = mapped_column(Vector())


# ---------------------------------------------------------------- integrations / gateway
@rls
class IntegrationConnection(Base):
    __tablename__ = "integration_connections"
    __table_args__ = (UniqueConstraint("org_id", "name"),)
    id: Mapped[uuid.UUID] = pk()
    org_id: Mapped[uuid.UUID] = org_fk()
    kind: Mapped[str] = mapped_column(String(32))  # sandbox_email | smtp | sandbox_crm | http_api
    name: Mapped[str] = mapped_column(String(160))
    config: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)  # non-secret settings
    secret_enc: Mapped[bytes | None] = mapped_column(LargeBinary)
    allowed_workflow_ids: Mapped[list[Any] | None] = mapped_column(JSON)  # None = all workflows
    rate_limit_per_minute: Mapped[int] = mapped_column(Integer, default=30)
    status: Mapped[str] = mapped_column(String(16), default="active")  # active | revoked
    last_tested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_test_ok: Mapped[bool | None] = mapped_column(Boolean)
    created_at: Mapped[datetime] = created()


@rls
class ToolCall(Base):
    """Gateway ledger. The unique idempotency key guarantees at-most-once side effects."""

    __tablename__ = "tool_calls"
    id: Mapped[uuid.UUID] = pk()
    org_id: Mapped[uuid.UUID] = org_fk()
    execution_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("workflow_executions.id", ondelete="SET NULL"), index=True
    )
    node_id: Mapped[str | None] = mapped_column(String(64))
    connection_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("integration_connections.id", ondelete="SET NULL")
    )
    tool: Mapped[str] = mapped_column(String(48))
    idempotency_key: Mapped[str] = mapped_column(String(200), unique=True)
    request_hash: Mapped[str] = mapped_column(String(64))
    request: Mapped[dict[str, Any]] = mapped_column(JSON)
    response: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String(16))  # pending | succeeded | failed | denied | unknown
    sandbox: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = created()


@rls
class SandboxMessage(Base):
    __tablename__ = "sandbox_outbox"
    id: Mapped[uuid.UUID] = pk()
    org_id: Mapped[uuid.UUID] = org_fk()
    connection_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("integration_connections.id", ondelete="SET NULL")
    )
    execution_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("workflow_executions.id", ondelete="SET NULL")
    )
    to: Mapped[str] = mapped_column(String(320))
    subject: Mapped[str] = mapped_column(String(500))
    body: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = created()


@rls
class CrmRecord(Base):
    __tablename__ = "crm_records"
    __table_args__ = (UniqueConstraint("org_id", "external_key"),)
    id: Mapped[uuid.UUID] = pk()
    org_id: Mapped[uuid.UUID] = org_fk()
    external_key: Mapped[str] = mapped_column(String(320))
    data: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


# ---------------------------------------------------------------- billing / usage / audit / compliance
@rls
class UsageEvent(Base):
    __tablename__ = "usage_events"
    __table_args__ = (Index("ix_usage_org_created", "org_id", "created_at"),)
    id: Mapped[uuid.UUID] = pk()
    org_id: Mapped[uuid.UUID] = org_fk()
    kind: Mapped[str] = mapped_column(String(24))  # llm | embedding | tool | execution | storage
    execution_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("workflow_executions.id", ondelete="SET NULL"), index=True
    )
    workflow_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("workflows.id", ondelete="SET NULL"))
    agent_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("agents.id", ondelete="SET NULL"), index=True)
    provider_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("llm_providers.id", ondelete="SET NULL"))
    model: Mapped[str | None] = mapped_column(String(200))
    tokens_in: Mapped[int] = mapped_column(Integer, default=0)
    tokens_out: Mapped[int] = mapped_column(Integer, default=0)
    quantity: Mapped[int] = mapped_column(Integer, default=1)
    cost_usd: Mapped[Decimal] = mapped_column(Money, default=0)
    idempotency_key: Mapped[str] = mapped_column(String(200), unique=True)
    created_at: Mapped[datetime] = created()


class Subscription(Base):
    __tablename__ = "subscriptions"
    id: Mapped[uuid.UUID] = pk()
    org_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), unique=True)
    plan: Mapped[str] = mapped_column(String(32), default="starter")
    status: Mapped[str] = mapped_column(String(24), default="active")
    stripe_customer_id: Mapped[str | None] = mapped_column(String(80))
    stripe_subscription_id: Mapped[str | None] = mapped_column(String(80))
    current_period_end: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = created()


@rls
class Invoice(Base):
    __tablename__ = "invoices"
    id: Mapped[uuid.UUID] = pk()
    org_id: Mapped[uuid.UUID] = org_fk()
    stripe_invoice_id: Mapped[str | None] = mapped_column(String(80), unique=True)
    amount_cents: Mapped[int] = mapped_column(Integer)
    currency: Mapped[str] = mapped_column(String(8))
    status: Mapped[str] = mapped_column(String(24))
    hosted_url: Mapped[str | None] = mapped_column(String(500))
    period_start: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    period_end: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = created()


@rls
class AuditEvent(Base):
    """Append-only (UPDATE/DELETE blocked by trigger)."""

    __tablename__ = "audit_events"
    __table_args__ = (Index("ix_audit_org_created", "org_id", "created_at"),)
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    org_id: Mapped[uuid.UUID] = org_fk()
    actor_type: Mapped[str] = mapped_column(String(16))  # user | agent | system
    actor_id: Mapped[str | None] = mapped_column(String(80))
    actor_label: Mapped[str | None] = mapped_column(String(200))
    action: Mapped[str] = mapped_column(String(80))
    resource_type: Mapped[str | None] = mapped_column(String(48))
    resource_id: Mapped[str | None] = mapped_column(String(80))
    data: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    ip: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = created()


@rls
class AIActAssessment(Base):
    __tablename__ = "ai_act_assessments"
    id: Mapped[uuid.UUID] = pk()
    org_id: Mapped[uuid.UUID] = org_fk()
    workflow_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("workflows.id", ondelete="CASCADE"))
    agent_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("agents.id", ondelete="CASCADE"))
    intended_purpose: Mapped[str] = mapped_column(Text)
    deployment_context: Mapped[str] = mapped_column(Text, default="")
    industry: Mapped[str | None] = mapped_column(String(80))
    answers: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    risk_class: Mapped[str] = mapped_column(String(32))  # prohibited_check | high_risk_candidate | limited | minimal
    obligations: Mapped[list[Any]] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String(32), default="needs_review")
    reviewer_note: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = created()
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


@rls
class DataSubjectRequest(Base):
    __tablename__ = "data_subject_requests"
    id: Mapped[uuid.UUID] = pk()
    org_id: Mapped[uuid.UUID] = org_fk()
    kind: Mapped[str] = mapped_column(String(16))  # access | erasure
    subject_email: Mapped[str] = mapped_column(String(320))
    status: Mapped[str] = mapped_column(String(16), default="open")
    result: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = created()
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
