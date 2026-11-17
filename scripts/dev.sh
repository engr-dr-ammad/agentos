#!/usr/bin/env bash
# Start API (8000), worker and web app (3000). Use --background to detach (Codespaces does this on start).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .logs
[ -d backend/.venv ] || bash scripts/setup.sh
(cd backend && .venv/bin/alembic upgrade head)

start() { # name, dir, command...
  local name=$1 dir=$2; shift 2
  if [ "${BG:-0}" = 1 ]; then (cd "$dir" && nohup "$@" > "../.logs/$name.log" 2>&1 &) ; else (cd "$dir" && "$@" 2>&1 | sed "s/^/[$name] /") & fi
}
[ "${1:-}" = "--background" ] && BG=1
pkill -f "uvicorn app.main:app" 2>/dev/null || true
pkill -f "app.engine.worker" 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true

start api backend .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
start worker backend .venv/bin/python -m app.engine.worker
start web frontend npm run dev
if [ "${BG:-0}" = 1 ]; then
  echo "AgentOS is starting: web http://localhost:3000 · API docs http://localhost:8000/api/docs · logs in .logs/"
else
  wait
fi
