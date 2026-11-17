#!/usr/bin/env bash
# One-time setup: Python + Node dependencies, database migrations, local .env with fresh secrets.
set -euo pipefail
cd "$(dirname "$0")/.."

python3 -m venv backend/.venv
backend/.venv/bin/pip install --quiet --upgrade pip
backend/.venv/bin/pip install --quiet -e "backend[dev]"
(cd frontend && npm ci --no-audit --no-fund)

if [ ! -f backend/.env ]; then
  SECRET=$(python3 -c "import secrets;print(secrets.token_urlsafe(48))")
  FERNET=$(backend/.venv/bin/python -c "from cryptography.fernet import Fernet;print(Fernet.generate_key().decode())")
  PUBLIC_URL="http://localhost:3000"; SECURE=false
  if [ -n "${CODESPACE_NAME:-}" ]; then
    PUBLIC_URL="https://${CODESPACE_NAME}-3000.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}"; SECURE=true
  fi
  cat > backend/.env <<ENV
AGENTOS_ENV=development
AGENTOS_SECRET_KEY=${SECRET}
AGENTOS_ENCRYPTION_KEY=${FERNET}
AGENTOS_PUBLIC_URL=${PUBLIC_URL}
AGENTOS_COOKIE_SECURE=${SECURE}
ENV
  echo "Created backend/.env with fresh secrets"
fi

for i in $(seq 1 30); do
  (cd backend && .venv/bin/alembic upgrade head) && break
  echo "Waiting for database… ($i)"; sleep 2
done
echo "Setup complete. Start everything with: bash scripts/dev.sh"
