from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from typing import Annotated, Any
from uuid import UUID

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .db import SessionLocal
from .models import AuditEvent, Membership, User
from .security import COOKIE_NAME, ROLE_RANK, decode_session_token


@dataclass(slots=True)
class Ctx:
    user: User
    org_id: UUID
    role: str
    db: AsyncSession
    ip: str | None

    def can(self, role: str) -> bool:
        return ROLE_RANK[self.role] >= ROLE_RANK[role]

    async def audit(self, action: str, resource_type: str | None = None, resource_id: Any = None, **data: Any):
        await audit(self.db, self.org_id, action, resource_type, resource_id, data,
                    actor_type="user", actor_id=str(self.user.id), actor_label=self.user.email, ip=self.ip)


async def audit(db: AsyncSession, org_id: UUID, action: str, resource_type: str | None = None,
                resource_id: Any = None, data: dict | None = None, *, actor_type: str = "system",
                actor_id: str | None = None, actor_label: str | None = None, ip: str | None = None) -> None:
    db.add(AuditEvent(org_id=org_id, actor_type=actor_type, actor_id=actor_id, actor_label=actor_label,
                      action=action, resource_type=resource_type,
                      resource_id=str(resource_id) if resource_id is not None else None,
                      data=data or {}, ip=ip))


def _client_ip(request: Request) -> str | None:
    fwd = request.headers.get("x-forwarded-for")
    return fwd.split(",")[0].strip() if fwd else (request.client.host if request.client else None)


async def _load_user(request: Request, db: AsyncSession, allow_mfa_pending: bool = False) -> tuple[User, dict]:
    token = request.cookies.get(COOKIE_NAME) or (
        request.headers.get("authorization", "").removeprefix("Bearer ").strip() or None
    )
    claims = decode_session_token(token) if token else None
    if not claims or (claims.get("mfa") and not allow_mfa_pending):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Please sign in")
    user = await db.get(User, UUID(claims["sub"]))
    if not user or user.session_version != claims.get("sv"):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session expired")
    return user, claims


async def current_user(request: Request) -> AsyncIterator[tuple[User, dict, AsyncSession]]:
    async with SessionLocal() as db:
        user, claims = await _load_user(request, db)
        yield user, claims, db


async def get_ctx(request: Request) -> AsyncIterator[Ctx]:
    """Authenticated, tenant-scoped request context (RLS active for the session)."""
    async with SessionLocal() as db:
        user, claims = await _load_user(request, db)
        if not claims.get("org"):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "No organisation selected")
        org_id = UUID(claims["org"])
        role = await db.scalar(
            select(Membership.role).where(Membership.org_id == org_id, Membership.user_id == user.id)
        )
        if role is None:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Not a member of this organisation")
        await db.commit()  # end unscoped transaction; next one gets app.org_id set
        db.info["org_id"] = org_id
        yield Ctx(user=user, org_id=org_id, role=role, db=db, ip=_client_ip(request))


CtxDep = Annotated[Ctx, Depends(get_ctx)]


def require(role: str) -> Callable[..., Any]:
    async def dep(ctx: CtxDep) -> Ctx:
        if not ctx.can(role):
            raise HTTPException(status.HTTP_403_FORBIDDEN, f"This action requires the {role} role or higher")
        return ctx

    return dep


Viewer = Annotated[Ctx, Depends(require("viewer"))]
Employee = Annotated[Ctx, Depends(require("employee"))]
Manager = Annotated[Ctx, Depends(require("manager"))]
Admin = Annotated[Ctx, Depends(require("admin"))]
Owner = Annotated[Ctx, Depends(require("owner"))]


async def get_or_404(db: AsyncSession, model: type, id_: UUID, org_id: UUID, label: str | None = None):
    obj = await db.get(model, id_)
    if obj is None or getattr(obj, "org_id", org_id) != org_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"{label or model.__name__} not found")
    return obj
