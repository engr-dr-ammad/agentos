from datetime import UTC, datetime
from decimal import Decimal
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Agent, LLMProvider, Organization, UsageEvent, Workflow
from ..security import decrypt
from .base import LLMError, LLMResult, Message, ProviderConfig
from .providers import build_provider

MTOK = Decimal(1_000_000)


class BudgetExceeded(LLMError):
    pass


def provider_from_row(row: LLMProvider):
    return build_provider(ProviderConfig(kind=row.kind, base_url=row.base_url,
                                         api_key=decrypt(row.api_key_enc), options=row.options or {}))


async def resolve_provider(db: AsyncSession, org_id: UUID, provider_id: UUID | str | None) -> LLMProvider:
    if provider_id:
        row = await db.get(LLMProvider, UUID(str(provider_id)))
        if row and row.org_id == org_id:
            return row
        raise LLMError("The model provider configured for this agent no longer exists")
    row = await db.scalar(
        select(LLMProvider).where(LLMProvider.org_id == org_id)
        .order_by(LLMProvider.is_default.desc(), LLMProvider.created_at).limit(1)
    )
    if row is None:
        raise LLMError("No model provider is configured. Add one under Integrations → AI models.")
    return row


def month_start() -> datetime:
    now = datetime.now(UTC)
    return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


async def spend_since(db: AsyncSession, org_id: UUID, *, agent_id=None, workflow_id=None) -> Decimal:
    q = select(func.coalesce(func.sum(UsageEvent.cost_usd), 0)).where(
        UsageEvent.org_id == org_id, UsageEvent.created_at >= month_start())
    if agent_id:
        q = q.where(UsageEvent.agent_id == agent_id)
    if workflow_id:
        q = q.where(UsageEvent.workflow_id == workflow_id)
    return Decimal(await db.scalar(q))


async def check_budgets(db: AsyncSession, org_id: UUID, agent_id: UUID | None = None,
                        workflow_id: UUID | None = None) -> None:
    """Hard spending limits, enforced before every model call (never by the model)."""
    org = await db.get(Organization, org_id)
    if org and org.monthly_budget_usd is not None and await spend_since(db, org_id) >= org.monthly_budget_usd:
        raise BudgetExceeded("Organisation monthly AI budget reached")
    if agent_id:
        agent = await db.get(Agent, agent_id)
        if agent and agent.monthly_budget_usd is not None and \
                await spend_since(db, org_id, agent_id=agent_id) >= agent.monthly_budget_usd:
            raise BudgetExceeded(f"Monthly budget for agent '{agent.name}' reached")
    if workflow_id:
        wf = await db.get(Workflow, workflow_id)
        if wf and wf.monthly_budget_usd is not None and \
                await spend_since(db, org_id, workflow_id=workflow_id) >= wf.monthly_budget_usd:
            raise BudgetExceeded(f"Monthly budget for workflow '{wf.name}' reached")


def cost_of(row: LLMProvider, tin: int, tout: int) -> Decimal:
    return (Decimal(tin) * Decimal(row.price_in_per_mtok or 0) + Decimal(tout) * Decimal(row.price_out_per_mtok or 0)) / MTOK


async def record_usage(db: AsyncSession, *, org_id: UUID, key: str, kind: str, cost: Decimal = Decimal(0),
                       tokens_in: int = 0, tokens_out: int = 0, quantity: int = 1, execution_id=None,
                       workflow_id=None, agent_id=None, provider_id=None, model=None) -> None:
    """Idempotent metering: the same key is never billed twice."""
    await db.execute(insert(UsageEvent).values(
        org_id=org_id, kind=kind, cost_usd=cost, tokens_in=tokens_in, tokens_out=tokens_out, quantity=quantity,
        execution_id=execution_id, workflow_id=workflow_id, agent_id=agent_id, provider_id=provider_id,
        model=model, idempotency_key=key,
    ).on_conflict_do_nothing(index_elements=["idempotency_key"]))


async def complete(db: AsyncSession, *, org_id: UUID, provider: LLMProvider, model: str | None,
                   messages: list[Message], usage_key: str, json_mode: bool = False, temperature: float = 0.2,
                   max_tokens: int = 1500, agent_id=None, workflow_id=None, execution_id=None,
                   ) -> tuple[LLMResult, Decimal]:
    await check_budgets(db, org_id, agent_id, workflow_id)
    model = model or provider.default_model
    result = await provider_from_row(provider).complete(messages, model, temperature=temperature,
                                                        max_tokens=max_tokens, json_mode=json_mode)
    cost = cost_of(provider, result.tokens_in, result.tokens_out)
    await record_usage(db, org_id=org_id, key=usage_key, kind="llm", cost=cost, tokens_in=result.tokens_in,
                       tokens_out=result.tokens_out, execution_id=execution_id, workflow_id=workflow_id,
                       agent_id=agent_id, provider_id=provider.id, model=model)
    return result, cost
