import re
import time
from collections import defaultdict, deque
from datetime import UTC, datetime
from uuid import UUID

import pyotp
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, EmailStr, Field, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import get_settings
from ..db import SessionLocal, get_session
from ..deps import CtxDep, _load_user, audit, current_user
from ..models import Invitation, LLMProvider, Membership, Organization, Subscription, User
from ..security import (
    COOKIE_NAME,
    create_session_token,
    decrypt,
    encrypt,
    hash_password,
    sha256,
    verify_password,
)

router = APIRouter(prefix="/auth", tags=["auth"])
settings = get_settings()

_attempts: dict[str, deque] = defaultdict(deque)


def _throttle(key: str, limit: int = 10, window: int = 300) -> None:
    q, now = _attempts[key], time.monotonic()
    while q and now - q[0] > window:
        q.popleft()
    if len(q) >= limit:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many attempts. Try again in a few minutes.")
    q.append(now)


class Password(BaseModel):
    password: str = Field(min_length=10, max_length=200)

    @field_validator("password")
    @classmethod
    def strong(cls, v: str) -> str:
        if not (re.search(r"[A-Za-z]", v) and re.search(r"\d", v)):
            raise ValueError("Use at least 10 characters including letters and numbers")
        return v


class RegisterIn(Password):
    email: EmailStr
    name: str = Field(min_length=1, max_length=200)
    company_name: str = Field(min_length=1, max_length=200)


class LoginIn(BaseModel):
    email: EmailStr
    password: str
    org_id: UUID | None = None


class MfaIn(BaseModel):
    code: str = Field(pattern=r"^\d{6}$")


def _slug(name: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:50] or "org"
    return f"{base}-{sha256(name + str(time.time_ns()))[:6]}"


def set_cookie(resp: Response, token: str) -> None:
    resp.set_cookie(COOKIE_NAME, token, httponly=True, samesite="lax", secure=settings.cookie_secure,
                    max_age=settings.session_hours * 3600, path="/")


async def _create_org(db: AsyncSession, user: User, name: str, role: str = "owner") -> Organization:
    org = Organization(name=name, slug=_slug(name))
    db.add(org)
    await db.flush()
    db.add(Membership(org_id=org.id, user_id=user.id, role=role))
    db.add(Subscription(org_id=org.id, plan="starter"))
    await db.flush()
    db.info["org_id"] = org.id
    return org


async def seed_org(db: AsyncSession, org: Organization) -> None:
    """Every new org gets the offline sandbox model and sandbox connections so it works immediately."""
    from ..models import IntegrationConnection

    await db.commit()
    db.info["org_id"] = org.id
    db.add(LLMProvider(org_id=org.id, name="Sandbox model (offline demo)", kind="sandbox",
                       default_model="sandbox-1", is_default=True, privacy_tier="self_hosted"))
    db.add(IntegrationConnection(org_id=org.id, kind="sandbox_email", name="Sandbox email",
                                 config={"note": "Messages are stored in the AgentOS outbox, never delivered."}))
    db.add(IntegrationConnection(org_id=org.id, kind="sandbox_crm", name="Built-in CRM (sandbox)", config={}))
    await audit(db, org.id, "org.created", "organization", org.id, {"name": org.name})


@router.post("/register", status_code=201)
async def register(body: RegisterIn, request: Request, response: Response, db: AsyncSession = Depends(get_session)):
    _throttle(f"reg:{request.client.host if request.client else ''}", limit=20, window=3600)
    email = body.email.lower()
    if await db.scalar(select(User.id).where(User.email == email)):
        raise HTTPException(status.HTTP_409_CONFLICT, "An account with this email already exists")
    user = User(email=email, name=body.name, password_hash=hash_password(body.password))
    db.add(user)
    await db.flush()
    org = await _create_org(db, user, body.company_name)
    await seed_org(db, org)
    await db.commit()
    set_cookie(response, create_session_token(user.id, org.id, user.session_version))
    return {"user": {"id": user.id, "email": user.email, "name": user.name}, "org_id": org.id}


@router.post("/login")
async def login(body: LoginIn, request: Request, response: Response, db: AsyncSession = Depends(get_session)):
    email = body.email.lower()
    _throttle(f"login:{email}")
    user = await db.scalar(select(User).where(User.email == email))
    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Email or password is incorrect")
    orgs = (await db.scalars(select(Membership.org_id).where(Membership.user_id == user.id)
                             .order_by(Membership.created_at))).all()
    org_id = body.org_id if body.org_id in orgs else (orgs[0] if orgs else None)
    set_cookie(response, create_session_token(user.id, org_id, user.session_version, mfa_pending=user.mfa_enabled))
    return {"mfa_required": user.mfa_enabled, "org_id": org_id}


@router.post("/mfa/verify")
async def mfa_verify(body: MfaIn, request: Request, response: Response):
    async with SessionLocal() as db:
        user, claims = await _load_user(request, db, allow_mfa_pending=True)
        _throttle(f"mfa:{user.id}", limit=8)
        if not user.mfa_enabled or not pyotp.TOTP(decrypt(user.mfa_secret_enc)).verify(body.code, valid_window=1):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid code")
        org = UUID(claims["org"]) if claims.get("org") else None
        set_cookie(response, create_session_token(user.id, org, user.session_version))
        return {"ok": True}


@router.post("/logout")
async def logout(response: Response):
    response.delete_cookie(COOKIE_NAME, path="/")
    return {"ok": True}


@router.post("/logout-everywhere")
async def logout_everywhere(response: Response, cu=Depends(current_user)):
    user, _, db = cu
    user.session_version += 1
    await db.commit()
    response.delete_cookie(COOKIE_NAME, path="/")
    return {"ok": True}


@router.get("/me")
async def me(cu=Depends(current_user)):
    user, claims, db = cu
    rows = (await db.execute(select(Organization, Membership.role).join(
        Membership, Membership.org_id == Organization.id).where(Membership.user_id == user.id)
        .order_by(Organization.name))).all()
    active = claims.get("org")
    orgs = [{"id": o.id, "name": o.name, "role": r, "plan": o.plan, "onboarded": o.onboarded,
             "industry": o.industry} for o, r in rows]
    return {"user": {"id": user.id, "email": user.email, "name": user.name, "mfa_enabled": user.mfa_enabled,
                     "is_platform_admin": user.is_platform_admin},
            "org": next((o for o in orgs if str(o["id"]) == active), None), "orgs": orgs}


class SwitchIn(BaseModel):
    org_id: UUID


@router.post("/switch-org")
async def switch_org(body: SwitchIn, response: Response, cu=Depends(current_user)):
    user, _, db = cu
    if not await db.scalar(select(Membership.id).where(Membership.user_id == user.id,
                                                       Membership.org_id == body.org_id)):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not a member of that organisation")
    set_cookie(response, create_session_token(user.id, body.org_id, user.session_version))
    return {"ok": True}


class NewOrgIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)


@router.post("/orgs", status_code=201)
async def create_org(body: NewOrgIn, response: Response, cu=Depends(current_user)):
    """Agencies can run several fully isolated client organisations."""
    user, _, db = cu
    org = await _create_org(db, user, body.name)
    await seed_org(db, org)
    await db.commit()
    set_cookie(response, create_session_token(user.id, org.id, user.session_version))
    return {"org_id": org.id}


@router.post("/mfa/setup")
async def mfa_setup(ctx: CtxDep):
    secret = pyotp.random_base32()
    ctx.user.mfa_secret_enc = encrypt(secret)
    await ctx.db.commit()
    uri = pyotp.TOTP(secret).provisioning_uri(name=ctx.user.email, issuer_name="AgentOS")
    return {"secret": secret, "otpauth_uri": uri}


@router.post("/mfa/enable")
async def mfa_enable(body: MfaIn, ctx: CtxDep):
    if not ctx.user.mfa_secret_enc or not pyotp.TOTP(decrypt(ctx.user.mfa_secret_enc)).verify(body.code,
                                                                                              valid_window=1):
        raise HTTPException(400, "Invalid code — check your authenticator app time")
    ctx.user.mfa_enabled = True
    await ctx.audit("user.mfa_enabled", "user", ctx.user.id)
    await ctx.db.commit()
    return {"ok": True}


@router.post("/mfa/disable")
async def mfa_disable(body: MfaIn, ctx: CtxDep):
    if not ctx.user.mfa_enabled or not pyotp.TOTP(decrypt(ctx.user.mfa_secret_enc)).verify(body.code,
                                                                                            valid_window=1):
        raise HTTPException(400, "Invalid code")
    ctx.user.mfa_enabled, ctx.user.mfa_secret_enc = False, None
    await ctx.audit("user.mfa_disabled", "user", ctx.user.id)
    await ctx.db.commit()
    return {"ok": True}


class AcceptIn(BaseModel):
    token: str
    name: str | None = None
    password: str | None = None


@router.post("/invitations/accept")
async def accept_invitation(body: AcceptIn, request: Request, response: Response,
                            db: AsyncSession = Depends(get_session)):
    inv = await db.scalar(select(Invitation).where(Invitation.token_hash == sha256(body.token)))
    if not inv or inv.accepted_at or inv.expires_at < datetime.now(UTC):
        raise HTTPException(400, "This invitation is invalid or has expired")
    user = await db.scalar(select(User).where(User.email == inv.email))
    if user is None:
        if not body.password or not body.name:
            raise HTTPException(400, "Choose a name and password to create your account")
        Password(password=body.password)
        user = User(email=inv.email, name=body.name, password_hash=hash_password(body.password))
        db.add(user)
        await db.flush()
    else:
        # Existing account must prove ownership with its password.
        if not body.password or not verify_password(body.password, user.password_hash):
            raise HTTPException(401, "Enter the password for your existing account")
    if not await db.scalar(select(Membership.id).where(Membership.org_id == inv.org_id,
                                                       Membership.user_id == user.id)):
        db.add(Membership(org_id=inv.org_id, user_id=user.id, role=inv.role))
    inv.accepted_at = datetime.now(UTC)
    await db.commit()
    db.info["org_id"] = inv.org_id
    await audit(db, inv.org_id, "member.joined", "user", user.id, {"role": inv.role},
                actor_type="user", actor_id=str(user.id), actor_label=user.email)
    await db.commit()
    set_cookie(response, create_session_token(user.id, inv.org_id, user.session_version,
                                              mfa_pending=user.mfa_enabled))
    return {"org_id": inv.org_id, "mfa_required": user.mfa_enabled}
