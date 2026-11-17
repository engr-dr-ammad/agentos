"""Database engine and tenant-scoped sessions.

Every org-scoped table has a Postgres row-level-security policy keyed on the
`app.org_id` setting. `tenant_session(org_id)` sets it (transaction-local) at the
start of every transaction, so a forgotten WHERE clause can never leak another
tenant's rows. Application code still filters by org_id explicitly.
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from uuid import UUID

from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from .config import get_settings

_settings = get_settings()
engine = create_async_engine(_settings.database_url, pool_pre_ping=True, pool_size=10, max_overflow=20)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)


@event.listens_for(SessionLocal.class_.sync_session_class, "after_begin")
def _set_tenant(session, transaction, connection):  # noqa: ARG001
    org_id = session.info.get("org_id")
    connection.execute(text("SELECT set_config('app.org_id', :o, true)"), {"o": str(org_id) if org_id else ""})


@asynccontextmanager
async def tenant_session(org_id: UUID | None) -> AsyncIterator[AsyncSession]:
    async with SessionLocal() as s:
        s.info["org_id"] = org_id
        yield s


async def get_session() -> AsyncIterator[AsyncSession]:
    """Unscoped session (only tables without RLS are visible): auth, orgs, memberships."""
    async with SessionLocal() as s:
        yield s
