from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="AGENTOS_", extra="ignore")

    env: str = "development"  # development | test | production
    # App connects as a non-owner role so Postgres row-level security applies.
    database_url: str = "postgresql+asyncpg://agentos_app:agentos_app@localhost:5432/agentos"
    # Migrations run as the schema owner.
    migration_database_url: str = "postgresql+asyncpg://agentos:agentos@localhost:5432/agentos"
    app_db_password: str = "agentos_app"  # noqa: S105 - dev default, override via env

    secret_key: str = Field(default="dev-insecure-secret-change-me-0123456789abcdef", min_length=32)
    # Fernet key (urlsafe base64, 32 bytes) used to encrypt API keys and integration secrets.
    encryption_key: str = "dGhpcy1pcy1hLWRldi1vbmx5LWtleS1jaGFuZ2UtbWU="
    session_hours: int = 12
    cookie_secure: bool = False
    public_url: str = "http://localhost:3000"

    # Allow LLM base URLs / HTTP integrations that resolve to private networks (e.g. local Ollama).
    allow_private_hosts: bool = True

    # Worker
    inline_worker: bool = False  # run the worker inside the API process (single-container deploys)
    worker_poll_seconds: float = 1.0
    worker_concurrency: int = 4
    max_nodes_per_execution: int = 200
    max_execution_seconds: int = 3600

    # Billing (optional — sandbox mode when unset)
    stripe_secret_key: str | None = None
    stripe_webhook_secret: str | None = None
    stripe_price_business: str | None = None
    stripe_price_professional: str | None = None

    max_upload_mb: int = 20

    @property
    def is_production(self) -> bool:
        return self.env == "production"


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    if s.is_production and (s.secret_key.startswith("dev-") or "dev-only" in s.encryption_key):
        raise RuntimeError("Set AGENTOS_SECRET_KEY and AGENTOS_ENCRYPTION_KEY in production")
    return s
