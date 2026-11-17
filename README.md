# AgentOS — AI Workforce Management Platform

Create, connect and manage AI agents that handle everyday business tasks, with a visual drag-and-drop workflow studio, human approvals, and **your own choice of AI model**.

**Try it now in your browser:** https://engr-dr-ammad.github.io/agentos/ (browser edition, no install)

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/engr-dr-ammad/agentos?quickstart=1)

> Build your AI workforce visually. Give every agent a job. Stay in control.

## Two editions, one codebase

| | Browser edition (GitHub Pages) | Server edition (Codespaces / Docker) |
|---|---|---|
| Link | https://engr-dr-ammad.github.io/agentos/ | your Codespace or server |
| Where data lives | IndexedDB in your browser | PostgreSQL with row-level security |
| Users | one person per browser | teams, roles, invitations, MFA |
| AI models | your key, called directly from the browser | your key, encrypted on the server |
| Email | sandbox outbox | real SMTP delivery |
| Schedules / delays | while the tab is open | always (background worker) |
| Webhooks, Stripe billing | — | ✅ |

The browser edition is the same Next.js app built as a static site (`npm run build:pages`). It swaps the HTTP API for an in-browser implementation of the same routes (`frontend/lib/local/`), with the same workflow engine semantics: validation, checkpointed steps, approvals bound to a payload hash, duplicate protection and budgets. `.github/workflows/pages.yml` publishes it on every push. Use it for demos and personal use. Use the server edition for real multi-user business data.

## Run it

### On GitHub (Codespaces): one click
1. Click **Open in GitHub Codespaces** above (or **Code → Codespaces → Create codespace on main**).
2. Wait for setup (about 3–5 minutes the first time). It installs dependencies, starts Postgres with pgvector, runs migrations and starts the API, worker and web app.
3. The app opens on port **3000**. Create a workspace and follow **Get started**.

Every new organisation includes an **offline sandbox model** and **sandbox email/CRM**, so the whole product works before you add an API key. Sandbox output is clearly labelled.

### Locally with Docker
```bash
cp .env.example .env    # set the secrets marked CHANGE ME
docker compose up -d --build
open http://localhost:3000
```

### Locally for development
Needs Python 3.12+, Node 22 and PostgreSQL 16 with pgvector.
```bash
bash scripts/setup.sh   # venv, npm ci, .env with fresh secrets, migrations
bash scripts/dev.sh     # API :8000 (docs at /api/docs), worker, web :3000
```

## Bring your own AI model (no vendor lock-in)
Go to **Integrations → AI models → Connect AI model**. AgentOS speaks three wire protocols, which together cover practically every provider:

| Protocol | Providers |
|---|---|
| OpenAI-compatible | OpenAI, Azure OpenAI, Mistral, Groq, DeepSeek, OpenRouter, Together, xAI, Fireworks, **Ollama, vLLM, LM Studio** (self-hosted) |
| Anthropic Messages | Claude models |
| Google Gemini | Gemini models (+ embeddings) |

- Each agent can use a different provider and model. Switching is a dropdown change.
- API keys are encrypted with Fernet on the server. They are never returned to the browser and never put into prompts.
- Enter each model's price per million tokens to get cost tracking and hard budgets (organisation, agent, workflow).
- An embedding model, if you set one, turns on semantic (pgvector) search in knowledge bases. Keyword search always works.

## What's in the box

| Area | Status |
|---|---|
| Multi-tenant orgs, Postgres row-level security, roles (owner/admin/manager/employee/viewer), invitations, agency multi-org | ✅ |
| Auth: Argon2id passwords, httpOnly session cookie, CSRF header, TOTP MFA, sign-out-everywhere, login throttling | ✅ |
| Onboarding + plain-English agent suggestions (nothing is deployed or authorised automatically) | ✅ |
| Agent marketplace: 16 validated templates across 15 categories | ✅ |
| Agents: profile, instructions, 4 operating modes, model settings, knowledge access, JSON-Schema outputs, budgets, immutable versions, rollback, sandbox testing | ✅ |
| Workflow Studio (React Flow): palette, drag-drop, zoom/pan, snapping, minimap, multi-select, copy/paste, undo/redo, auto-layout, context menu, inspector, live validation | ✅ |
| Node types: manual/webhook/schedule triggers, AI agent, if/else, transform, validate, knowledge search, deterministic pricing check, approval, human task, send email, CRM upsert, approved REST call, wait, end | ✅ |
| Versioning: draft vs immutable published versions, executions pinned to version and agent version, diff, restore, clone, import/export | ✅ |
| Durable execution: checkpointed per step, retries with backoff, timeouts, cancellation, error routing, durable delays, crash recovery, `SKIP LOCKED` worker pool | ✅ |
| Approvals bound to a SHA-256 of the exact action, expiry, delegation, separation of duties, request changes | ✅ |
| Tool gateway: tenant/connection/workflow scope, approval check, rate limit, idempotency (no duplicate emails), audit | ✅ |
| Knowledge base: PDF/DOCX/TXT/MD/CSV/JSON/HTML parsing, chunking, FTS + pgvector hybrid retrieval, ACL in SQL, versioning, deletion propagation, citations | ✅ |
| Tasks: natural-language → structured task (cron detection), server-side state machine, list/kanban/calendar/workload/timeline, recurring schedules, result review | ✅ |
| Analytics: overview, spend & executions per day, agent performance, by model, CSV export | ✅ |
| Billing: plan limits, metering (idempotent), budgets, Stripe Checkout/Portal/webhooks (billing sandbox when Stripe isn't configured) | ✅ |
| GDPR: access/erasure requests, retention setting, data region; EU AI Act structured self-assessment with legal-review gate | ✅ |
| Append-only audit log (DB trigger), security headers, SSRF guard for model/API URLs | ✅ |
| Public site: home, pricing, security, docs, contact, terms/privacy templates | ✅ |
| Integrations: SMTP email (works with Gmail/M365 app passwords), webhooks (HMAC), REST API, built-in CRM | ✅ |
| OAuth connectors (Gmail, Outlook, Calendar, Drive, Slack, Teams, HubSpot, Shopify, Stripe), SAML/SCIM, PDF reports, node grouping, bounded loops | 🔜 not implemented yet (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#not-yet-implemented)) |

## Reference workflow
In **Workflow Studio**, click **Quotation starter**. It builds the full spec workflow:
customer enquiry (webhook) → Receptionist agent → Quotation agent (catalogue knowledge) → **deterministic pricing rules** → manager **approval bound to the exact email** → send email → CRM update → result. Pricing-rule violations go to a human task instead. Link the Quotation agent to a knowledge base containing your catalogue so it can quote real prices.

## Tests
```bash
cd backend && .venv/bin/pytest -q     # 21 tests: isolation, RLS, approvals, idempotency, retries, budgets, webhooks, adapters…
cd frontend && npm test && npm run typecheck && npm run build
```
The default suite uses the deterministic sandbox model and HTTP mocks. It needs no paid API calls. CI runs everything on every push (`.github/workflows/ci.yml`), and `images.yml` publishes container images to GHCR.

## Repository layout
```
backend/   FastAPI API, workflow engine (app/engine), tool gateway, LLM adapters (app/llm), Alembic migrations, tests
frontend/  Next.js 15 + React 19 + Tailwind v4 + React Flow + TanStack Query
docs/      Architecture, decisions, threat model, roadmap
.devcontainer/  Codespaces configuration
```

See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the design, decisions, threat model and roadmap.
