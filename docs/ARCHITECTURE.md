# AgentOS architecture

## System overview

```
Browser ──► Next.js (web, :3000) ──/api/* rewrite──► FastAPI (api, :8000) ──► PostgreSQL 16 + pgvector
                                                          │                         ▲
                                                          │ enqueue (job_queue)     │ checkpoints, RLS
                                                          ▼                         │
                                                   Worker(s) ─── workflow executor ─┤
                                                          │                         │
                                       LLM adapters ◄─────┤                         │
              (OpenAI-compatible / Anthropic / Gemini / sandbox)                    │
                                                          └──► Tool gateway ──► SMTP · REST APIs · sandbox outbox/CRM
```

* The browser only talks to its own origin. The session cookie is httpOnly, SameSite=Lax, and every write also needs the `X-AgentOS-CSRF` header.
* **API** (`backend/app/api/*`): typed Pydantic schemas, versioned under `/api/v1`, with OpenAPI docs at `/api/docs`.
* **Worker** (`app/engine/worker.py`): claims jobs with `FOR UPDATE SKIP LOCKED` and lease timeouts, fires cron schedules, and supports any number of instances.
* **Executor** (`app/engine/executor.py`): runs a published, immutable definition and checkpoints each node in `node_executions`.
* **Tool gateway** (`app/gateway.py`): the only code path that produces external side effects.

## Key decisions

| Decision | Why |
|---|---|
| **Postgres-backed durable executor instead of Temporal + LangGraph** | The spec asks for durability, retries, scheduling, approvals and recovery, and also says to avoid unnecessary complexity. Postgres already holds the data, so checkpoints live in the same transaction as business records. That gives exactly-once checkpointing without a second consistency domain, and it runs in a Codespace without extra services. The executor interface (`run_execution` → done/requeue/park) maps 1:1 onto a Temporal workflow if scale ever demands it. Agent reasoning is a bounded single-call-plus-repair loop with schema validation, so LangGraph's graph runtime is not needed yet. |
| **Thin first-party LLM adapters instead of LiteLLM** | Three wire protocols cover every major vendor. About 250 lines of audited code keep the dependency surface small (LiteLLM's PyPI package was compromised in 2026) and keep error classification (transient vs permanent) precise for the retry logic. |
| **Row-level security as defence in depth** | The app connects as `agentos_app` (NOBYPASSRLS, not the table owner), and `FORCE ROW LEVEL SECURITY` applies policies even to the owner. Each transaction sets `app.org_id`, so a forgotten `WHERE org_id = …` returns zero rows instead of another tenant's data. Cross-tenant tables (`job_queue`, `schedules`, `webhook_endpoints`) hold no business content. |
| **Actions are nodes, not model tool-calls** | A model can only propose data. Side effects happen in explicit action nodes that pass the gateway. Approvals bind to `sha256(canonical_json({action, request}))`, and the gateway recomputes it at send time. |
| **Deterministic pricing** | `finance.price_check` uses `Decimal` with ROUND_HALF_UP. No LLM is involved in money arithmetic. |
| **Redis not required** | Rate limits use the gateway ledger and login throttling is in-process. Add Redis when running many API replicas behind a load balancer (see roadmap). |
| **Workflow definition stored as JSONB** | Published versions are immutable snapshots. Normalised `workflow_nodes`/`workflow_edges` tables would add joins without adding guarantees. Executions reference `(workflow_id, version)` plus pinned agent versions. |

## Execution model

1. `start_execution` checks plan quota, creates the `workflow_executions` row and enqueues a job in the same transaction.
2. The worker claims the job and loads the immutable definition (or the draft snapshot for test runs).
3. Nodes run in topological order. A node is active if any incoming edge is active. An edge is active when its source completed with a matching branch (`default`, `true/false`, `ok/violation`, `valid/invalid`, `error`). A node whose inputs are all inactive is `skipped`.
4. Each node result is committed before the next starts.
   * Transient errors (HTTP 429/5xx, timeouts, rate limit): retry with exponential backoff up to `max_attempts`.
   * Permanent errors: fail the run, or follow the `error` path when `on_error=continue`.
   * Approvals park the job until the decision or the expiry deadline. Delays requeue at `resume_at`.
5. Cancellation is checked between nodes. Limits cover max nodes, max duration, per-node timeout, and budgets checked before every model call.

## Agent runtime safeguards
* The system prompt marks `<input>` and `<documents>` as untrusted data. Agents never execute actions themselves.
* Retrieval is restricted in SQL to the agent's linked knowledge bases.
* Output must validate against the agent's JSON Schema (one repair attempt).
* Budget checks run before each call, token limits apply per call, and usage metering is idempotent per `(execution, node, attempt, try)`.

## Threat model (STRIDE summary)

| Threat | Mitigation |
|---|---|
| Cross-tenant data access | RLS on every org table, server-side role checks, tenant-scoped worker sessions, isolation tests |
| Prompt / document injection triggering actions | Models have no tool access. Actions need gateway checks and bound approvals. Content is marked untrusted. |
| Approval bait-and-switch | Payload hash bound at request time, compared again at decision time (client must send the reviewed hash) and at send time |
| Duplicate emails / payments | Unique idempotency key per (execution, node). An unknown outcome after a crash is never retried automatically. |
| Credential leakage | Fernet encryption at rest; secrets are decrypted only in adapters and the gateway, never serialised to API responses or prompts |
| SSRF via model base URL / REST connection | `assert_safe_url` blocks private, loopback and link-local targets when `AGENTOS_ALLOW_PRIVATE_HOSTS=false`; REST paths are locked to the connection host |
| CSRF / XSS / clickjacking | Custom header requirement, SameSite cookies, React escaping, `X-Frame-Options: DENY`, nosniff |
| Brute force | Argon2id, per-email throttling, TOTP MFA, session versioning for global logout |
| Webhook spoofing / replays | HMAC-SHA256 over the raw body, constant-time compare, optional `Idempotency-Key` dedupe |
| Resource exhaustion | Upload size limits, plan quotas, step/time/token limits, per-connection rate limits, hard budgets |
| Repudiation | Append-only `audit_events` (DB trigger and revoked UPDATE/DELETE) covering user, agent and system actors |

## Not yet implemented
These are deliberately left out of v0.1. The UI labels them as planned and does not pretend they work.
* OAuth connectors (Gmail, Outlook, Google/Microsoft Calendar, Drive/OneDrive, Slack, Teams, HubSpot, Shopify, Stripe as a data source). Today: SMTP, REST and webhooks.
* SAML SSO / SCIM, custom enterprise roles, dedicated infrastructure.
* PDF and scheduled reports (CSV export exists), cost alerts by email.
* Node grouping and bounded loop nodes in the studio; supervisor-style dynamic delegation between agents.
* OpenTelemetry tracing export, documented load tests (performance targets are **not yet measured**), backup/restore runbooks.
* Model routing policies by cost and latency (agents choose a provider and model explicitly; the org default is the fallback).

## Roadmap
1. OAuth connector framework plus Gmail/Outlook, then Slack/Teams and HubSpot.
2. OpenTelemetry, load-test suite (k6) and published p95 results.
3. Redis for distributed rate limits and sessions; horizontal API scaling guide.
4. Temporal adapter for very long-running enterprise workflows.
5. Partner template marketplace with signed, sandbox-validated submissions.
