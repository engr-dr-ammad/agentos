import os
import subprocess
import sys
from pathlib import Path

import pytest

DB = os.environ.get("TEST_DB_NAME", "agentos_test")
HOST = os.environ.get("TEST_DB_HOST", "localhost")
os.environ.setdefault("AGENTOS_ENV", "test")
os.environ["AGENTOS_DATABASE_URL"] = f"postgresql+asyncpg://agentos_app:agentos_app@{HOST}:5432/{DB}"
os.environ["AGENTOS_MIGRATION_DATABASE_URL"] = f"postgresql+asyncpg://agentos:agentos@{HOST}:5432/{DB}"

ROOT = Path(__file__).resolve().parents[1]


def pytest_sessionstart(session):
    # Fresh schema for every test session.
    env = {**os.environ}
    subprocess.run([sys.executable, "-m", "alembic", "downgrade", "base"], cwd=ROOT, env=env, check=False,
                   capture_output=True)
    r = subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"], cwd=ROOT, env=env,
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr)


@pytest.fixture(scope="session")
def anyio_backend():
    return "asyncio"
