import hashlib
import ipaddress
import json
import secrets
import socket
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlparse
from uuid import UUID

import jwt
from cryptography.fernet import Fernet, InvalidToken
from pwdlib import PasswordHash

from .config import get_settings

_settings = get_settings()
_pwd = PasswordHash.recommended()  # Argon2id
_fernet = Fernet(_settings.encryption_key.encode())

ROLE_RANK = {"viewer": 0, "employee": 1, "manager": 2, "admin": 3, "owner": 4}
COOKIE_NAME = "agentos_session"


def hash_password(p: str) -> str:
    return _pwd.hash(p)


def verify_password(p: str, h: str) -> bool:
    try:
        return _pwd.verify(p, h)
    except Exception:  # malformed hash
        return False


def encrypt(value: str) -> bytes:
    return _fernet.encrypt(value.encode())


def decrypt(token: bytes | None) -> str | None:
    if token is None:
        return None
    try:
        return _fernet.decrypt(bytes(token)).decode()
    except InvalidToken as e:
        raise RuntimeError("Cannot decrypt stored secret (encryption key changed?)") from e


def secret_hint(value: str) -> str:
    return f"…{value[-4:]}" if len(value) >= 8 else "…"


def sha256(data: str | bytes) -> str:
    return hashlib.sha256(data.encode() if isinstance(data, str) else data).hexdigest()


def canonical_hash(obj: Any) -> str:
    """Stable hash of a JSON payload — binds approvals to an exact action."""
    return sha256(json.dumps(obj, sort_keys=True, separators=(",", ":"), default=str))


def new_token(nbytes: int = 32) -> str:
    return secrets.token_urlsafe(nbytes)


def create_session_token(user_id: UUID, org_id: UUID | None, session_version: int, mfa_pending: bool = False) -> str:
    now = datetime.now(UTC)
    payload = {
        "sub": str(user_id),
        "org": str(org_id) if org_id else None,
        "sv": session_version,
        "mfa": mfa_pending,
        "iat": now,
        "exp": now + timedelta(minutes=10 if mfa_pending else _settings.session_hours * 60),
    }
    return jwt.encode(payload, _settings.secret_key, algorithm="HS256")


def decode_session_token(token: str) -> dict[str, Any] | None:
    try:
        return jwt.decode(token, _settings.secret_key, algorithms=["HS256"])
    except jwt.PyJWTError:
        return None


class UnsafeURLError(ValueError):
    pass


def assert_safe_url(url: str) -> None:
    """Block SSRF to internal networks unless explicitly allowed (e.g. local Ollama in dev)."""
    u = urlparse(url)
    if u.scheme not in ("https", "http") or not u.hostname:
        raise UnsafeURLError("URL must be http(s) with a host")
    if _settings.allow_private_hosts:
        return
    if u.scheme != "https":
        raise UnsafeURLError("Only https URLs are allowed")
    try:
        infos = socket.getaddrinfo(u.hostname, None)
    except socket.gaierror as e:
        raise UnsafeURLError(f"Cannot resolve host {u.hostname}") from e
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
            raise UnsafeURLError("URL resolves to a private or reserved address")
