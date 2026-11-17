/**
 * Browser edition "server": implements the same /api/v1 routes as the FastAPI backend,
 * on top of IndexedDB. Used only when NEXT_PUBLIC_EDITION=browser (GitHub Pages build).
 */
import PLANS_JSON from "./data/plans.json";
import TEMPLATES_JSON from "./data/templates.json";
import { type Row, type State, db, flush, insert, now, remove, save, uid } from "./db";
import {
  HttpError, SPECS, TASK_TRANSITIONS, TERMINAL, audit, blocking, buildGraph, definitionOf, nextRun, runExecution, setChangeListener, sha256, spend,
  transitionTask, validate, type Definition,
} from "./engine";
import { chunkText, extractText, providerCfg, retrieve } from "./knowledge";
import { LLMError, buildProvider } from "./llm";

type Tpl = { id: string; name: string; description: string; category: string; industries: string[]; department: string; instructions: string; safety_constraints: string[];
  default_mode: string; output_schema: object; keywords: string[]; approvals: string[]; required_integrations: string[]; status: string; test_cases?: unknown };
const TEMPLATES = TEMPLATES_JSON as unknown as Tpl[];
type Ctx = { s: State; user: Row; org: Row; role: string };
type Handler = (c: Ctx, p: Record<string, string>, body: unknown, q: URLSearchParams) => unknown | Promise<unknown>;

const RANK: Record<string, number> = { viewer: 0, employee: 1, manager: 2, admin: 3, owner: 4 };
const bad = (status: number, msg: string, data?: unknown) => new HttpError(status, msg, data);
const need = <T,>(v: T | undefined | null, what: string): T => { if (v === undefined || v === null) throw bad(404, `${what} not found`); return v; };
const B = (b: unknown) => (b ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const pick = (o: Row, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o[k] ?? null]));
const scoped = (rows: Row[], c: Ctx) => rows.filter((r) => r.org_id === c.org.id);
const find = (rows: Row[], c: Ctx, id: string, what: string) => need(rows.find((r) => r.id === id && r.org_id === c.org.id), what);
const hasKeywordMatch = (t: Tpl, text: string) => t.keywords.filter((k) => text.includes(k)).length;

async function pbkdf2(password: string, salt: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: new TextEncoder().encode(salt), iterations: 210_000, hash: "SHA-256" }, key, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ------------------------------------------------------------------ background runner (while the tab is open) */
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let started = false;
const listeners = new Set<() => void>();
export const onDataChange = (f: () => void) => { listeners.add(f); return () => listeners.delete(f); };

function enqueue(s: State, exId: string, at?: string) {
  const job = s.t.jobs.find((j) => j.execution_id === exId);
  const when = at ?? now();
  if (job) job.run_after = when; else insert(s.t.jobs, { execution_id: exId, run_after: when });
  save();
  const t = timers.get(exId); if (t) clearTimeout(t);
  timers.set(exId, setTimeout(() => process(s, exId), Math.max(0, new Date(when).getTime() - Date.now())));
}
const running = new Set<string>();
async function process(s: State, exId: string) {
  if (running.has(exId)) return;
  running.add(exId);
  try {
    const r = await runExecution(s, exId).catch((e) => { console.error(e); return { action: "requeue" as const, at: new Date(Date.now() + 30_000).toISOString() }; });
    if (r.action === "requeue") enqueue(s, exId, r.at); else remove(s.t.jobs, (j) => j.execution_id === exId);
  } finally { running.delete(exId); listeners.forEach((f) => f()); }
}
function startRunner(s: State) {
  if (started || typeof window === "undefined") return;
  started = true;
  setChangeListener(() => listeners.forEach((f) => f()));
  for (const j of s.t.jobs) enqueue(s, j.execution_id as string, j.run_after as string);
  const tick = async () => {
    for (const sc of s.t.schedules.filter((x) => x.enabled && (x.next_run_at as string) <= now())) {
      sc.next_run_at = nextRun(sc.cron as string, (sc.timezone as string) || "UTC");
      const org = s.t.orgs.find((o) => o.id === sc.org_id); if (!org) continue;
      const c: Ctx = { s, user: s.t.users[0], org, role: "owner" };
      try {
        if (sc.workflow_id) { const wf = s.t.workflows.find((w) => w.id === sc.workflow_id); if (wf?.status === "active" && wf.published_version) startExecution(c, wf, { scheduled_at: now() }, "schedule"); }
        else if (sc.task_id) { const t = s.t.tasks.find((x) => x.id === sc.task_id); if (t && !["Cancelled", "Expired", "Draft"].includes(t.status as string)) runTask(c, t, true); }
      } catch (e) { console.warn("schedule failed", e); }
    }
    save();
  };
  setInterval(tick, 30_000); tick();
  window.addEventListener("beforeunload", () => { void flush(); });
}

/* ------------------------------------------------------------------ shared operations */
function startExecution(c: Ctx, wf: Row | null, input: Record<string, unknown>, trigger = "manual", mode = "production", definition: Definition | null = null, taskId: string | null = null): Row {
  if (mode === "production" && !definition && (!wf || wf.status !== "active" || !wf.published_version)) throw bad(409, "This workflow is not active. Publish and activate it first.");
  const ex = insert(c.s.t.executions, { org_id: c.org.id, workflow_id: wf?.id ?? null, version: wf && !definition ? wf.published_version : 0, definition, mode, status: "queued", trigger_type: trigger,
    input, output: null, error: null, cost_usd: 0, cancel_requested: false, task_id: taskId, created_by: c.user.id, started_at: null, finished_at: null });
  audit(c.s, c.org.id, "execution.started", "execution", ex.id, { workflow_id: wf?.id ?? null, mode, trigger }, "user", c.user.email as string);
  enqueue(c.s, ex.id);
  return ex;
}
function runTask(c: Ctx, t: Row, recurring = false): Row {
  if (!["Ready", "Failed"].includes(t.status as string) && !(recurring && t.status === "Completed")) throw bad(409, `Only ready tasks can run (current status: ${t.status})`);
  transitionTask(c.s, t, "Queued", c.user.id, "Run requested", false);
  if (t.workflow_id) return startExecution(c, need(c.s.t.workflows.find((w) => w.id === t.workflow_id), "Workflow"), { ...(t.inputs as object), task: t.title }, "task", "production", null, t.id);
  if (!t.agent_id) throw bad(422, "This task is assigned to a person, not an agent or workflow");
  const defn: Definition = { nodes: [
    { id: "trigger", type: "trigger.manual", data: { label: "Task", config: {} } },
    { id: "agent", type: "agent", data: { label: "Agent", config: { agent_id: t.agent_id, task: `${t.title}\n\n${t.description}\n\nExpected output: ${t.expected_output || "as appropriate"}`, input: "{{ trigger }}" } } },
    { id: "end", type: "control.end", data: { label: "Result", config: { result: { output: "{{ nodes.agent.result }}", sources: "{{ nodes.agent.sources }}" } } } }],
    edges: [{ id: "e1", source: "trigger", target: "agent" }, { id: "e2", source: "agent", target: "end" }] };
  return startExecution(c, null, (t.inputs as Record<string, unknown>) ?? {}, "task", "production", defn, t.id);
}
const agentCfg = (s: State, a: Row) => s.t.agent_versions.find((v) => v.agent_id === a.id && v.version === a.current_version)?.config as Record<string, unknown>;
function agentStats(s: State, aid: string) {
  const nes = s.t.node_executions.filter((n) => n.node_type === "agent" && (n.input as Record<string, unknown>)?.agent_id === aid);
  const ok = nes.filter((n) => n.status === "completed").length, fail = nes.filter((n) => ["failed", "failed_continued"].includes(n.status as string)).length;
  const durs = nes.filter((n) => n.started_at && n.finished_at).map((n) => (new Date(n.finished_at as string).getTime() - new Date(n.started_at as string).getTime()) / 1000);
  return { attempted: nes.length, completed: ok, failed: fail, success_rate: nes.length ? Math.round((ok / nes.length) * 1000) / 1000 : null,
    cost_usd: nes.reduce((a, n) => a + Number(n.cost_usd), 0), avg_seconds: durs.length ? Math.round((durs.reduce((a, b) => a + b, 0) / durs.length) * 100) / 100 : null };
}
const agentOut = (s: State, a: Row, withCfg = true) => ({ ...pick(a, ["id", "name", "description", "department", "status", "current_version", "template_id", "monthly_budget_usd", "escalation_contact", "owner_id", "created_at", "updated_at"]),
  ...(withCfg ? { config: agentCfg(s, a) } : {}), stats: agentStats(s, a.id) });
function createAgent(c: Ctx, b: Record<string, any>): Row { // eslint-disable-line @typescript-eslint/no-explicit-any
  const a = insert(c.s.t.agents, { org_id: c.org.id, name: b.name, description: b.description ?? "", department: b.department ?? null, escalation_contact: b.escalation_contact ?? null,
    monthly_budget_usd: b.monthly_budget_usd ?? null, template_id: b.template_id ?? null, owner_id: c.user.id, status: "draft", current_version: 1, updated_at: now() });
  insert(c.s.t.agent_versions, { org_id: c.org.id, agent_id: a.id, version: 1, config: { ...defaultCfg(), ...(b.config ?? {}) }, note: "Created" });
  audit(c.s, c.org.id, "agent.created", "agent", a.id, { name: a.name, template: b.template_id ?? null }, "user", c.user.email as string);
  return a;
}
const defaultCfg = () => ({ role: "", instructions: "", mode: "approval_required", provider_id: null, model: null, temperature: 0.2, max_tokens: 1500,
  output_schema: { type: "object", properties: { result: { type: "string" } }, required: ["result"] }, knowledge_base_ids: [], retrieval_k: 5 });
const exOut = (s: State, e: Row) => ({ ...pick(e, ["id", "workflow_id", "version", "mode", "status", "trigger_type", "error", "created_at", "started_at", "finished_at", "task_id"]),
  cost_usd: Number(e.cost_usd ?? 0), workflow_name: (s.t.workflows.find((w) => w.id === e.workflow_id)?.name as string) ?? null });
const wfOut = (s: State, w: Row, detail = false) => ({ ...pick(w, ["id", "name", "description", "status", "published_version", "monthly_budget_usd", "created_at", "updated_at"]),
  node_count: ((w.draft as Definition)?.nodes ?? []).length, ...(detail ? { draft: w.draft, has_webhook: false } : {}),
  last_run_at: s.t.executions.filter((e) => e.workflow_id === w.id).map((e) => e.created_at as string).sort().pop() ?? null });
const taskOut = (s: State, t: Row) => ({ ...pick(t, ["id", "title", "description", "agent_id", "workflow_id", "owner_id", "priority", "status", "due_at", "schedule_cron", "inputs", "expected_output", "requires_approval", "dependencies", "result", "error", "created_at", "updated_at"]),
  cost_usd: Number(t.cost_usd ?? 0), agent_name: (s.t.agents.find((a) => a.id === t.agent_id)?.name as string) ?? null, allowed_transitions: [...(TASK_TRANSITIONS[t.status as string] ?? [])].sort() });
function syncTaskSchedule(c: Ctx, t: Row) {
  const sc = c.s.t.schedules.find((x) => x.task_id === t.id);
  const active = !!t.schedule_cron && ["Ready", "Completed", "Failed", "Running", "Queued", "Awaiting Approval"].includes(t.status as string);
  if (t.schedule_cron) { if (sc) { sc.cron = t.schedule_cron; sc.enabled = active; } else insert(c.s.t.schedules, { org_id: c.org.id, task_id: t.id, workflow_id: null, cron: t.schedule_cron, timezone: c.org.timezone ?? "UTC", next_run_at: nextRun(t.schedule_cron as string, (c.org.timezone as string) || "UTC"), enabled: active }); }
  else if (sc) remove(c.s.t.schedules, (x) => x.id === sc.id);
}
const providerOut = (p: Row) => ({ ...pick(p, ["id", "name", "kind", "base_url", "default_model", "embedding_model", "options", "is_default", "price_in_per_mtok", "price_out_per_mtok", "privacy_tier", "last_tested_at", "last_test_ok"]),
  has_key: !!p.api_key, api_key_hint: p.api_key ? `…${String(p.api_key).slice(-4)}` : null });
const CONN_TYPES = {
  sandbox_email: { label: "Sandbox email", secret: null, fields: [], description: "Stores messages in the AgentOS outbox. Nothing is delivered." },
  sandbox_crm: { label: "Built-in CRM", secret: null, fields: [], description: "A simple customer record store inside AgentOS." },
  http_api: { label: "REST API", secret: "Auth header value (e.g. 'Bearer …')", fields: ["base_url", "auth_header"], description: "Call an approved HTTP API directly from your browser (the API must allow CORS). Requests are locked to this host." },
};
const connOut = (c: Row) => ({ ...pick(c, ["id", "kind", "name", "config", "allowed_workflow_ids", "rate_limit_per_minute", "status", "last_tested_at", "last_test_ok", "created_at"]),
  has_secret: !!c.secret, label: (CONN_TYPES as Record<string, { label: string }>)[c.kind as string]?.label ?? "Email (SMTP — server edition)" });
const PRESETS = [
  { id: "openai", label: "OpenAI", kind: "openai_compatible", base_url: "https://api.openai.com/v1", model_hint: "e.g. gpt-4o-mini", embedding_hint: "text-embedding-3-small" },
  { id: "anthropic", label: "Anthropic Claude", kind: "anthropic", base_url: "https://api.anthropic.com", model_hint: "e.g. claude-sonnet-4-5" },
  { id: "gemini", label: "Google Gemini", kind: "gemini", base_url: "https://generativelanguage.googleapis.com/v1beta", model_hint: "e.g. gemini-2.5-flash", embedding_hint: "text-embedding-004" },
  { id: "mistral", label: "Mistral", kind: "openai_compatible", base_url: "https://api.mistral.ai/v1", model_hint: "e.g. mistral-small-latest" },
  { id: "groq", label: "Groq", kind: "openai_compatible", base_url: "https://api.groq.com/openai/v1", model_hint: "model id from Groq console" },
  { id: "deepseek", label: "DeepSeek", kind: "openai_compatible", base_url: "https://api.deepseek.com/v1", model_hint: "e.g. deepseek-chat" },
  { id: "openrouter", label: "OpenRouter", kind: "openai_compatible", base_url: "https://openrouter.ai/api/v1", model_hint: "e.g. meta-llama/llama-3.1-70b-instruct" },
  { id: "together", label: "Together AI", kind: "openai_compatible", base_url: "https://api.together.xyz/v1", model_hint: "model id" },
  { id: "ollama", label: "Ollama on this computer", kind: "openai_compatible", base_url: "http://localhost:11434/v1", model_hint: "e.g. llama3.1 — start Ollama with OLLAMA_ORIGINS=*", no_key: true },
];
const PROHIBITED = { manipulation: "Subliminal or manipulative techniques causing harm", social_scoring: "Social scoring", emotion_workplace: "Emotion recognition in the workplace or education" };
const ANNEX = { biometrics: "Biometric identification or categorisation", critical_infrastructure: "Safety component of critical infrastructure", education: "Admission, assessment or proctoring in education",
  employment: "Recruitment, selection, promotion, termination or task allocation of workers", essential_services: "Access to essential services, credit scoring, insurance pricing",
  law_enforcement: "Law enforcement, migration, asylum or border control", justice: "Administration of justice or democratic processes" };
const DAYS: Record<string, number> = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 0 };
function parseSchedule(text: string): [string | null, string | null] {
  const s = text.toLowerCase(); let h = 9, mi = 0;
  const m = s.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/);
  if (m) { h = +m[1]; mi = +(m[2] ?? 0); const ap = (m[3] ?? "").replace(/\./g, ""); if (ap === "pm" && h < 12) h += 12; if (ap === "am" && h === 12) h = 0; }
  const hm = `${mi} ${h}`, t = `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
  if (/\b(every|each)\s+hour\b|\bhourly\b/.test(s)) return ["0 * * * *", "Every hour"];
  const days = Object.keys(DAYS).filter((d) => new RegExp(`\\b${d}s?\\b`).test(s));
  if (/\b(every|each)\s+(week)?day\b|\bdaily\b|\bevery morning\b/.test(s)) return s.includes("weekday") ? [`${hm} * * 1-5`, `Weekdays at ${t}`] : [`${hm} * * *`, `Every day at ${t}`];
  if (days.length && /\b(every|each|on)\b/.test(s)) return [`${hm} * * ${days.map((d) => DAYS[d]).join(",")}`, `Every ${days.map((d) => d[0].toUpperCase() + d.slice(1)).join(", ")} at ${t}`];
  if (/\bweekly\b|\bevery week\b/.test(s)) return [`${hm} * * 1`, `Every Monday at ${t}`];
  if (/\bmonthly\b|\bevery month\b/.test(s)) return [`${hm} 1 * *`, `1st of every month at ${t}`];
  return [null, null];
}
function diff(a: Definition, b: Definition) {
  const an = new Map(a.nodes.map((n) => [n.id, n])), bn = new Map(b.nodes.map((n) => [n.id, n]));
  const strip = (n: Definition["nodes"][number]) => JSON.stringify({ t: n.type, l: n.data?.label, c: Object.fromEntries(Object.entries(n.data?.config ?? {}).filter(([k]) => k !== "agent_version")) });
  const ek = (e: Definition["edges"][number]) => `${e.source}>${e.target}>${e.sourceHandle ?? ""}`;
  const ae = new Set(a.edges.map(ek)), be = new Set(b.edges.map(ek));
  return { added_nodes: [...bn.keys()].filter((k) => !an.has(k)).map((k) => bn.get(k)!.data?.label ?? k), removed_nodes: [...an.keys()].filter((k) => !bn.has(k)).map((k) => an.get(k)!.data?.label ?? k),
    changed_nodes: [...an.keys()].filter((k) => bn.has(k) && strip(an.get(k)!) !== strip(bn.get(k)!)).map((k) => ({ node: bn.get(k)!.data?.label ?? k })),
    added_connections: [...be].filter((x) => !ae.has(x)).length, removed_connections: [...ae].filter((x) => !be.has(x)).length };
}
function seedOrg(s: State, user: Row, name: string): Row {
  const org = insert(s.t.orgs, { name, industry: null, size: null, country: null, language: "en", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, objective: null, website: null,
    plan: "browser", monthly_budget_usd: null, retention_days: 365, data_region: "browser", onboarded: false });
  insert(s.t.memberships, { org_id: org.id, user_id: user.id, role: "owner", department: null });
  insert(s.t.providers, { org_id: org.id, name: "Sandbox model (offline demo)", kind: "sandbox", base_url: null, api_key: null, options: {}, default_model: "sandbox-1", embedding_model: null,
    price_in_per_mtok: 0, price_out_per_mtok: 0, is_default: true, privacy_tier: "self_hosted", last_tested_at: null, last_test_ok: null });
  insert(s.t.connections, { org_id: org.id, kind: "sandbox_email", name: "Sandbox email", config: { note: "Messages are stored in the AgentOS outbox, never delivered." }, secret: null, allowed_workflow_ids: null, rate_limit_per_minute: 30, status: "active" });
  insert(s.t.connections, { org_id: org.id, kind: "sandbox_crm", name: "Built-in CRM (sandbox)", config: {}, secret: null, allowed_workflow_ids: null, rate_limit_per_minute: 30, status: "active" });
  audit(s, org.id, "org.created", "organization", org.id, { name }, "user", user.email as string);
  return org;
}
const NOT_IN_BROWSER = (what: string) => bad(400, `${what} is available in the server edition (Codespaces or Docker). This browser edition is single-user and keeps all data in your browser.`);

/* ------------------------------------------------------------------ routes */
const R: [string, string, Handler][] = [];
const r = (method: string, path: string, h: Handler) => R.push([method, path, h]);

// auth & org
r("GET", "/auth/me", ({ s, user, org, role }) => ({ user: { ...pick(user, ["id", "email", "name"]), mfa_enabled: false, is_platform_admin: false },
  org: { id: org.id, name: org.name, role, plan: org.plan, onboarded: org.onboarded, industry: org.industry },
  orgs: s.t.memberships.filter((m) => m.user_id === user.id).map((m) => { const o = s.t.orgs.find((x) => x.id === m.org_id)!; return { id: o.id, name: o.name, role: m.role, plan: o.plan }; }) }));
r("POST", "/auth/logout", ({ s }) => { s.session = null; save(); return { ok: true }; });
r("POST", "/auth/logout-everywhere", ({ s }) => { s.session = null; save(); return { ok: true }; });
r("POST", "/auth/switch-org", ({ s, user }, _, b) => { need(s.t.memberships.find((m) => m.user_id === user.id && m.org_id === B(b).org_id), "Organisation"); s.session = { user_id: user.id, org_id: B(b).org_id }; save(); return { ok: true }; });
r("POST", "/auth/orgs", ({ s, user }, _, b) => { const o = seedOrg(s, user, B(b).name); s.session = { user_id: user.id, org_id: o.id }; save(); return { org_id: o.id }; });
r("POST", "/auth/mfa/setup", () => { throw NOT_IN_BROWSER("Two-factor authentication"); });
r("GET", "/org", ({ org, role }) => ({ ...pick(org, ["id", "name", "industry", "size", "country", "language", "timezone", "objective", "website", "monthly_budget_usd", "retention_days", "data_region", "onboarded", "plan"]), role }));
r("PATCH", "/org", (c, _, b) => { Object.assign(c.org, B(b)); audit(c.s, c.org.id, "org.updated", "organization", c.org.id, { fields: Object.keys(B(b)) }, "user", c.user.email as string); save(); return { ok: true }; });
r("POST", "/onboarding/suggest", (_, __, b) => {
  const text = ` ${String(B(b).description).toLowerCase()} `; const ind = String(B(b).industry ?? "").toLowerCase();
  const scored = TEMPLATES.map((t) => [hasKeywordMatch(t, text) * 2 + (ind && t.industries.map((i) => i.toLowerCase()).includes(ind) ? 1 : 0), t] as const).filter(([sc, t]) => sc > 0 && hasKeywordMatch(t, text) >= 0).sort((a, b) => b[0] - a[0] || a[1].name.localeCompare(b[1].name)).slice(0, 5).map(([, t]) => t);
  return (scored.length ? scored : TEMPLATES.filter((t) => ["receptionist", "communication"].includes(t.id))).map((t) => ({ template_id: t.id, name: t.name, description: t.description, category: t.category, required_integrations: t.required_integrations, approvals: t.approvals, default_mode: t.default_mode }));
});
r("GET", "/team/members", ({ s, org }) => s.t.memberships.filter((m) => m.org_id === org.id).map((m) => { const u = s.t.users.find((x) => x.id === m.user_id)!; return { user_id: u.id, name: u.name, email: u.email, role: m.role, department: m.department, mfa_enabled: false, joined_at: m.created_at }; }));
r("GET", "/team/invitations", () => []);
r("POST", "/team/invitations", () => { throw NOT_IN_BROWSER("Inviting team members"); });
r("GET", "/departments", (c) => scoped(c.s.t.departments, c).map((d) => pick(d, ["id", "name"])));
r("GET", "/audit", (c, _, __, q) => { const f = (q.get("q") ?? "").toLowerCase(); return scoped(c.s.t.audit, c).filter((e) => !f || `${e.action} ${e.actor_label}`.toLowerCase().includes(f)).slice(-Number(q.get("limit") ?? 200)).reverse()
  .map((e) => ({ id: e.id, at: e.created_at, actor_type: e.actor_type, actor: e.actor_label, action: e.action, resource_type: e.resource_type, resource_id: e.resource_id, data: e.data, ip: null })); });
r("GET", "/privacy/requests", (c) => scoped(c.s.t.dsr, c).slice().reverse());
r("POST", "/privacy/requests", (c, _, b) => {
  const email = String(B(b).subject_email).toLowerCase();
  const crm = scoped(c.s.t.crm, c).filter((x) => String(x.external_key).toLowerCase() === email), out = scoped(c.s.t.outbox, c).filter((x) => String(x.to).toLowerCase() === email);
  const nc = ["Uploaded knowledge documents", "Execution inputs/outputs"];
  let result: Record<string, unknown> = { crm_records: crm.map((x) => x.data), outbox_messages: out.length, not_covered: nc };
  if (B(b).kind === "erasure") { remove(c.s.t.crm, (x) => crm.includes(x)); remove(c.s.t.outbox, (x) => out.includes(x)); result = { erased_crm_records: crm.length, erased_outbox_messages: out.length, not_covered: nc }; }
  const d = insert(c.s.t.dsr, { org_id: c.org.id, kind: B(b).kind, subject_email: email, status: "completed", result, completed_at: now() });
  audit(c.s, c.org.id, `privacy.${B(b).kind}`, "data_subject_request", d.id, {}, "user", c.user.email as string);
  return { id: d.id, result };
});
r("GET", "/compliance/ai-act/questions", () => ({ prohibited: PROHIBITED, high_risk: ANNEX, transparency: { interacts_with_people: "The system interacts directly with people", generates_content: "The system generates text/images shown to the public" } }));
r("GET", "/compliance/ai-act", (c) => scoped(c.s.t.assessments, c).slice().reverse().map((a) => ({ ...pick(a, ["id", "workflow_id", "risk_class", "obligations", "status", "created_at"]), purpose: a.intended_purpose })));
r("POST", "/compliance/ai-act", (c, _, b) => {
  const ans = (B(b).answers ?? {}) as Record<string, boolean>; let risk = "minimal"; let obl: string[] = [];
  if (Object.keys(PROHIBITED).some((k) => ans[k])) { risk = "prohibited_check"; obl = ["Potentially prohibited practice (Art. 5) — do not deploy; obtain legal review."]; }
  else if (Object.keys(ANNEX).some((k) => ans[k])) { risk = "high_risk_candidate"; obl = ["Possible high-risk use (Annex III): risk management, data governance, logging, human oversight, accuracy and robustness obligations may apply.", "Deployer duties include human oversight, monitoring and informing affected persons.", "Qualified legal review is required before production use."]; }
  else { if (ans.interacts_with_people) obl.push("Inform people they are interacting with an AI system (Art. 50)."); if (ans.generates_content) obl.push("Mark or disclose AI-generated content where required (Art. 50)."); risk = obl.length ? "limited" : "minimal"; obl.push("Keep this assessment up to date when the purpose or context changes."); }
  const a = insert(c.s.t.assessments, { org_id: c.org.id, ...B(b), risk_class: risk, obligations: obl, status: ["prohibited_check", "high_risk_candidate"].includes(risk) ? "needs_legal_review" : "self_assessed" });
  return { id: a.id, risk_class: risk, obligations: obl, status: a.status, disclaimer: "This is a structured self-assessment, not a determination of legal compliance." };
});
r("POST", "/compliance/ai-act/:id/review", (c, p, b) => { const a = find(c.s.t.assessments, c, p.id, "Assessment"); a.status = "reviewed"; a.reviewer_note = B(b).note; save(); return { ok: true }; });

// agents & templates
r("GET", "/templates", (_, __, ___, q) => TEMPLATES.filter((t) => t.status === "published" && (!q.get("category") || t.category === q.get("category"))).map(({ instructions, test_cases, keywords, ...t }) => t)); // eslint-disable-line @typescript-eslint/no-unused-vars
r("GET", "/templates/:id", (_, p) => need(TEMPLATES.find((t) => t.id === p.id), "Template"));
r("GET", "/agents", (c) => scoped(c.s.t.agents, c).sort((a, b) => String(a.department ?? "~").localeCompare(String(b.department ?? "~")) || String(a.name).localeCompare(String(b.name))).map((a) => agentOut(c.s, a)));
r("GET", "/agents/:id", (c, p) => { const a = find(c.s.t.agents, c, p.id, "Agent"); return { ...agentOut(c.s, a), versions: c.s.t.agent_versions.filter((v) => v.agent_id === a.id).sort((x, y) => Number(y.version) - Number(x.version)).map((v) => pick(v, ["version", "note", "created_at", "config"])) }; });
r("POST", "/agents", (c, _, b) => agentOut(c.s, createAgent(c, B(b))));
r("POST", "/agents/from-template", (c, _, b) => {
  const t = need(TEMPLATES.find((x) => x.id === B(b).template_id), "Template");
  return agentOut(c.s, createAgent(c, { name: B(b).name ?? t.name, description: t.description, department: B(b).department ?? t.department, template_id: t.id,
    config: { role: t.description, instructions: `${t.instructions}\n\nConstraints:\n- ${t.safety_constraints.join("\n- ")}`, mode: t.default_mode, output_schema: t.output_schema } }));
});
r("PATCH", "/agents/:id", (c, p, b) => {
  const a = find(c.s.t.agents, c, p.id, "Agent"); const { config, note, ...rest } = B(b);
  Object.assign(a, rest, { updated_at: now() });
  if (config && JSON.stringify(config) !== JSON.stringify(agentCfg(c.s, a))) { a.current_version = Number(a.current_version) + 1; insert(c.s.t.agent_versions, { org_id: c.org.id, agent_id: a.id, version: a.current_version, config, note: note ?? "Updated" }); }
  audit(c.s, c.org.id, "agent.updated", "agent", a.id, { version: a.current_version }, "user", c.user.email as string); save();
  return agentOut(c.s, a);
});
r("POST", "/agents/:id/status", (c, p, b) => { const a = find(c.s.t.agents, c, p.id, "Agent"); a.status = B(b).status; audit(c.s, c.org.id, `agent.${a.status}`, "agent", a.id, {}, "user", c.user.email as string); save(); return { ok: true, status: a.status }; });
r("POST", "/agents/:id/rollback", (c, p, b) => { const a = find(c.s.t.agents, c, p.id, "Agent"); const v = need(c.s.t.agent_versions.find((x) => x.agent_id === a.id && x.version === B(b).version), "Version");
  a.current_version = Number(a.current_version) + 1; insert(c.s.t.agent_versions, { org_id: c.org.id, agent_id: a.id, version: a.current_version, config: v.config, note: `Rolled back to v${B(b).version}` }); return { ok: true, current_version: a.current_version }; });
r("DELETE", "/agents/:id", (c, p) => { const a = find(c.s.t.agents, c, p.id, "Agent"); remove(c.s.t.agents, (x) => x.id === a.id); remove(c.s.t.agent_versions, (x) => x.agent_id === a.id); return { ok: true }; });
r("POST", "/agents/:id/test", async (c, p, b) => {
  const a = find(c.s.t.agents, c, p.id, "Agent");
  const defn: Definition = { nodes: [{ id: "trigger", type: "trigger.manual", data: { label: "Test input", config: {} } },
    { id: "agent", type: "agent", data: { label: String(a.name), config: { agent_id: a.id, agent_version: B(b).version ?? a.current_version, task: B(b).task, input: "{{ trigger }}", max_attempts: 1 } } }],
    edges: [{ id: "e1", source: "trigger", target: "agent" }] };
  const inp = B(b).input; const ex = insert(c.s.t.executions, { org_id: c.org.id, workflow_id: null, version: 0, definition: defn, mode: "test", status: "queued", trigger_type: "agent_test",
    input: inp && typeof inp === "object" ? inp : { text: inp }, cost_usd: 0, cancel_requested: false, task_id: null, created_by: c.user.id });
  await runExecution(c.s, ex.id);
  const ne = c.s.t.node_executions.find((n) => n.execution_id === ex.id && n.node_id === "agent");
  return { execution_id: ex.id, status: ex.status, error: ex.error ?? null, output: ne?.output ?? null, tokens_in: ne?.tokens_in ?? 0, tokens_out: ne?.tokens_out ?? 0, cost_usd: Number(ne?.cost_usd ?? 0),
    duration_seconds: ne?.finished_at && ne.started_at ? (new Date(ne.finished_at as string).getTime() - new Date(ne.started_at as string).getTime()) / 1000 : null };
});
r("POST", "/agents/propose", (_, __, b) => {
  const text = ` ${String(B(b).description).toLowerCase()} `;
  const t = TEMPLATES.slice().sort((x, y) => hasKeywordMatch(y, text) - hasKeywordMatch(x, text))[0];
  return { name: t.name, description: String(B(b).description).slice(0, 300), department: t.department, template_id: t.id, source: "template_match",
    config: { role: String(B(b).description).slice(0, 2000), mode: t.default_mode, instructions: t.instructions, output_schema: t.output_schema } };
});

// workflows
r("GET", "/node-types", () => SPECS);
r("GET", "/workflows", (c) => scoped(c.s.t.workflows, c).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).map((w) => wfOut(c.s, w)));
r("POST", "/workflows", (c, _, b) => { const w = insert(c.s.t.workflows, { org_id: c.org.id, name: B(b).name, description: B(b).description ?? "", status: "draft", draft: B(b).draft ?? { nodes: [], edges: [] }, published_version: null, monthly_budget_usd: null, updated_at: now() });
  audit(c.s, c.org.id, "workflow.created", "workflow", w.id, { name: w.name }, "user", c.user.email as string); return wfOut(c.s, w, true); });
r("POST", "/workflows/import", (c, _, b) => { if (B(b).format !== "agentos.workflow/v1") throw bad(422, "Not an AgentOS workflow export"); const w = insert(c.s.t.workflows, { org_id: c.org.id, name: B(b).name, description: B(b).description ?? "", status: "draft", draft: B(b).definition, published_version: null, updated_at: now() }); return wfOut(c.s, w, true); });
r("GET", "/workflows/:id", (c, p) => wfOut(c.s, find(c.s.t.workflows, c, p.id, "Workflow"), true));
r("PATCH", "/workflows/:id", (c, p, b) => { const w = find(c.s.t.workflows, c, p.id, "Workflow"); Object.assign(w, B(b), { updated_at: now() }); save(); return wfOut(c.s, w, true); });
r("DELETE", "/workflows/:id", (c, p) => { const w = find(c.s.t.workflows, c, p.id, "Workflow");
  if (c.s.t.executions.some((e) => e.workflow_id === w.id && !TERMINAL.has(e.status as string))) throw bad(409, "This workflow has executions in progress. Cancel them first.");
  remove(c.s.t.workflows, (x) => x.id === w.id); remove(c.s.t.schedules, (x) => x.workflow_id === w.id); return { ok: true }; });
r("POST", "/workflows/:id/validate", (c, p, b) => { const w = find(c.s.t.workflows, c, p.id, "Workflow"); const d = B(b).nodes ? (b as Definition) : (w.draft as Definition); const issues = validate(d, c.s, c.org.id, w.id); return { valid: !blocking(issues), issues }; });
r("POST", "/workflows/:id/publish", (c, p, b) => {
  const w = find(c.s.t.workflows, c, p.id, "Workflow"); const issues = validate(w.draft as Definition, c.s, c.org.id, w.id);
  if (blocking(issues)) throw bad(422, "Fix the highlighted problems before publishing", { detail: { message: "Fix the highlighted problems before publishing", issues } });
  const version = Math.max(0, ...c.s.t.workflow_versions.filter((v) => v.workflow_id === w.id).map((v) => Number(v.version))) + 1;
  const defn = JSON.parse(JSON.stringify(w.draft)) as Definition;
  for (const n of defn.nodes) if (n.type === "agent") { const a = c.s.t.agents.find((x) => x.id === n.data?.config?.agent_id); if (a) n.data!.config!.agent_version = a.current_version; }
  insert(c.s.t.workflow_versions, { org_id: c.org.id, workflow_id: w.id, version, definition: defn, note: B(b).note ?? null });
  w.published_version = version; if (B(b).activate !== false) w.status = "active";
  const trig = defn.nodes.find((n) => n.type.startsWith("trigger.")); remove(c.s.t.schedules, (x) => x.workflow_id === w.id);
  if (trig?.type === "trigger.schedule") insert(c.s.t.schedules, { org_id: c.org.id, workflow_id: w.id, task_id: null, cron: trig.data?.config?.cron, timezone: trig.data?.config?.timezone ?? "UTC", next_run_at: nextRun(String(trig.data?.config?.cron), String(trig.data?.config?.timezone ?? "UTC")), enabled: w.status === "active" });
  audit(c.s, c.org.id, "workflow.published", "workflow", w.id, { version }, "user", c.user.email as string); save();
  return { version, status: w.status, issues };
});
r("POST", "/workflows/:id/status", (c, p, b) => { const w = find(c.s.t.workflows, c, p.id, "Workflow"); if (B(b).status === "active" && !w.published_version) throw bad(400, "Publish the workflow before activating it");
  w.status = B(b).status; c.s.t.schedules.filter((x) => x.workflow_id === w.id).forEach((x) => { x.enabled = w.status === "active"; }); save(); return { ok: true, status: w.status }; });
r("GET", "/workflows/:id/versions", (c, p) => c.s.t.workflow_versions.filter((v) => v.workflow_id === p.id && v.org_id === c.org.id).sort((a, b) => Number(b.version) - Number(a.version)).map((v) => ({ ...pick(v, ["version", "note", "created_at"]), node_count: (v.definition as Definition).nodes.length })));
r("GET", "/workflows/:id/diff", (c, p, _, q) => { const w = find(c.s.t.workflows, c, p.id, "Workflow"); const get = (v: string | null) => v ? c.s.t.workflow_versions.find((x) => x.workflow_id === w.id && String(x.version) === v)?.definition as Definition : w.draft as Definition;
  return diff(need(get(q.get("base")), "Version"), need(get(q.get("target")), "Version")); });
r("POST", "/workflows/:id/versions/:v/restore", (c, p) => { const w = find(c.s.t.workflows, c, p.id, "Workflow"); w.draft = need(c.s.t.workflow_versions.find((x) => x.workflow_id === w.id && String(x.version) === p.v), "Version").definition; save(); return wfOut(c.s, w, true); });
r("POST", "/workflows/:id/clone", (c, p) => { const w = find(c.s.t.workflows, c, p.id, "Workflow"); return wfOut(c.s, insert(c.s.t.workflows, { org_id: c.org.id, name: `${w.name} (copy)`, description: w.description, status: "draft", draft: JSON.parse(JSON.stringify(w.draft)), published_version: null, updated_at: now() }), true); });
r("GET", "/workflows/:id/export", (c, p) => { const w = find(c.s.t.workflows, c, p.id, "Workflow"); return { format: "agentos.workflow/v1", name: w.name, description: w.description, definition: w.draft }; });
r("POST", "/workflows/:id/run", (c, p, b) => {
  const w = find(c.s.t.workflows, c, p.id, "Workflow"); let defn: Definition | null = null;
  if (B(b).mode === "test") { const issues = validate(w.draft as Definition, c.s, c.org.id, w.id); if (blocking(issues)) throw bad(422, "Fix the highlighted problems before testing", { detail: { message: "Fix the highlighted problems before testing", issues } }); defn = JSON.parse(JSON.stringify(w.draft)); }
  const ex = startExecution(c, w, B(b).input ?? {}, "manual", B(b).mode ?? "production", defn);
  return { execution_id: ex.id, status: ex.status, mode: ex.mode };
});
r("POST", "/workflows/:id/webhook/rotate", () => { throw NOT_IN_BROWSER("Webhooks"); });
r("GET", "/executions", (c, _, __, q) => scoped(c.s.t.executions, c).filter((e) => (!q.get("workflow_id") || e.workflow_id === q.get("workflow_id")) && (!q.get("status") || e.status === q.get("status")))
  .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, Number(q.get("limit") ?? 50)).map((e) => exOut(c.s, e)));
r("GET", "/executions/:id", (c, p) => { const e = find(c.s.t.executions, c, p.id, "Execution"); let defn: Definition | null = null; try { defn = definitionOf(c.s, e); } catch { /* deleted */ }
  return { ...exOut(c.s, e), input: e.input, output: e.output ?? null, definition: defn, redacted: false,
    nodes: c.s.t.node_executions.filter((n) => n.execution_id === e.id).sort((a, b) => String(a.started_at ?? "~").localeCompare(String(b.started_at ?? "~"))).map((n) => ({ node_id: n.node_id, type: n.node_type, status: n.status, attempt: n.attempt, output: n.output, error: n.error,
      cost_usd: Number(n.cost_usd), tokens_in: n.tokens_in, tokens_out: n.tokens_out, started_at: n.started_at, finished_at: n.finished_at,
      duration_ms: n.finished_at && n.started_at ? new Date(n.finished_at as string).getTime() - new Date(n.started_at as string).getTime() : null })),
    approvals: c.s.t.approvals.filter((a) => a.execution_id === e.id).map((a) => pick(a, ["id", "node_id", "status"])) }; });
r("POST", "/executions/:id/cancel", (c, p) => { const e = find(c.s.t.executions, c, p.id, "Execution"); if (TERMINAL.has(e.status as string)) throw bad(409, "Execution already finished"); e.cancel_requested = true; enqueue(c.s, e.id); return { ok: true }; });

// approvals
const canDecide = (c: Ctx, a: Row) => RANK[c.role] >= (RANK[a.approver_role as string] ?? 2);
r("GET", "/approvals", (c, _, __, q) => scoped(c.s.t.approvals, c).filter((a) => !q.get("status") || q.get("status") === "all" || a.status === q.get("status")).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
  .map((a) => ({ ...a, workflow_name: (c.s.t.workflows.find((w) => w.id === a.workflow_id)?.name as string) ?? null, can_decide: canDecide(c, a) })));
r("GET", "/approvals/count", (c) => ({ pending: scoped(c.s.t.approvals, c).filter((a) => a.status === "pending").length }));
r("POST", "/approvals/:id/decide", (c, p, b) => {
  const a = find(c.s.t.approvals, c, p.id, "Approval");
  if (a.status !== "pending") throw bad(409, `This approval is already ${a.status}`);
  if (a.expires_at && new Date(a.expires_at as string) < new Date()) throw bad(409, "This approval has expired");
  if (!canDecide(c, a)) throw bad(403, `Only a ${a.approver_role} or higher can decide this approval`);
  if (B(b).payload_hash !== a.payload_hash) throw bad(409, "The proposed action changed. Reload and review it again.");
  if (B(b).decision !== "approve" && !B(b).comment) throw bad(422, "Please explain what should change");
  a.status = ({ approve: "approved", reject: "rejected", request_changes: "changes_requested" } as Record<string, string>)[B(b).decision];
  Object.assign(a, { decided_by: c.user.id, decided_at: now(), comment: B(b).comment ?? null });
  audit(c.s, c.org.id, `approval.${a.status}`, "approval", a.id, { execution_id: a.execution_id, payload_hash: a.payload_hash }, "user", c.user.email as string);
  enqueue(c.s, a.execution_id as string);
  return a;
});

// tasks
r("GET", "/tasks", (c, _, __, q) => scoped(c.s.t.tasks, c).filter((t) => (!q.get("status") || t.status === q.get("status")) && (!q.get("agent_id") || t.agent_id === q.get("agent_id"))).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).map((t) => taskOut(c.s, t)));
r("POST", "/tasks", (c, _, b) => {
  const { status, ...rest } = B(b);
  if (rest.schedule_cron) { try { nextRun(rest.schedule_cron); } catch { throw bad(422, "Invalid schedule"); } }
  const t = insert(c.s.t.tasks, { org_id: c.org.id, title: "", description: "", agent_id: null, workflow_id: null, priority: "normal", due_at: null, schedule_cron: null, inputs: {}, expected_output: null, requires_approval: true, dependencies: [], ...rest,
    owner_id: c.user.id, status: "Draft", result: null, error: null, cost_usd: 0, updated_at: now() });
  insert(c.s.t.task_events, { org_id: c.org.id, task_id: t.id, from_status: null, to_status: "Draft", actor_id: c.user.id, note: null });
  if (status === "Ready") transitionTask(c.s, t, "Ready", c.user.id);
  syncTaskSchedule(c, t); save(); return taskOut(c.s, t);
});
r("POST", "/tasks/parse", (c, _, b) => {
  const text = String(B(b).text); const [cron, human] = parseSchedule(text); const lower = ` ${text.toLowerCase()} `;
  const matched = TEMPLATES.filter((t) => hasKeywordMatch(t, lower)).sort((x, y) => hasKeywordMatch(y, lower) - hasKeywordMatch(x, lower));
  const agents = scoped(c.s.t.agents, c); const agent = matched.map((t) => agents.find((a) => a.template_id === t.id)).find(Boolean) ?? null;
  const sentence = text.trim().split(/[.!?\n]/)[0]; const title = sentence.replace(/^(every|each)\s+\w+(\s+at\s+[\d:apm. ]+)?,?\s*/i, "").trim() || sentence;
  const needs = /\b(send|email|pay|publish|delete|order|purchase|remind|post)\w*/i.test(text);
  return { title: title[0].toUpperCase() + title.slice(1, 300), description: text, schedule_cron: cron, schedule_human: human, agent_id: agent?.id ?? null, agent_name: agent?.name ?? null,
    suggested_template: !agent && matched[0] ? matched[0].id : null, requires_approval: needs, approval_reason: needs ? "The request involves external communication or money." : null, confirm_required: true };
});
r("GET", "/tasks/:id", (c, p) => { const t = find(c.s.t.tasks, c, p.id, "Task"); return { ...taskOut(c.s, t),
  events: c.s.t.task_events.filter((e) => e.task_id === t.id).map((e) => ({ from: e.from_status, to: e.to_status, at: e.created_at, note: e.note })),
  executions: c.s.t.executions.filter((e) => e.task_id === t.id).slice(-20).reverse().map((e) => ({ id: e.id, status: e.status, created_at: e.created_at, cost_usd: Number(e.cost_usd) })) }; });
r("PATCH", "/tasks/:id", (c, p, b) => { const t = find(c.s.t.tasks, c, p.id, "Task"); if (["Running", "Queued"].includes(t.status as string)) throw bad(409, "A running task cannot be edited"); Object.assign(t, B(b), { updated_at: now() }); save(); return taskOut(c.s, t); });
r("POST", "/tasks/:id/transition", (c, p, b) => { const t = find(c.s.t.tasks, c, p.id, "Task");
  if (B(b).to === "Ready" && !(t.agent_id || t.workflow_id || t.owner_id)) throw bad(422, "Assign the task first");
  transitionTask(c.s, t, B(b).to, c.user.id, B(b).note ?? null);
  if (B(b).to === "Cancelled") c.s.t.executions.filter((e) => e.task_id === t.id && !TERMINAL.has(e.status as string)).forEach((e) => { e.cancel_requested = true; enqueue(c.s, e.id); });
  syncTaskSchedule(c, t); save(); return taskOut(c.s, t); });
r("POST", "/tasks/:id/run", (c, p) => { const t = find(c.s.t.tasks, c, p.id, "Task"); const ex = runTask(c, t); return { execution_id: ex.id, status: t.status }; });
r("POST", "/tasks/:id/review", (c, p, b) => { const t = find(c.s.t.tasks, c, p.id, "Task"); if (t.status !== "Awaiting Approval") throw bad(409, "This task is not awaiting review");
  transitionTask(c.s, t, B(b).decision === "accept" ? "Completed" : "Failed", c.user.id, B(b).note ?? `Result ${B(b).decision}ed`); save(); return taskOut(c.s, t); });

// knowledge
r("GET", "/knowledge/bases", (c) => scoped(c.s.t.kbs, c).map((k) => ({ ...pick(k, ["id", "name", "description", "sensitivity", "embedding_provider_id", "created_at"]), documents: c.s.t.documents.filter((d) => d.kb_id === k.id).length })));
r("POST", "/knowledge/bases", (c, _, b) => { if (scoped(c.s.t.kbs, c).some((k) => k.name === B(b).name)) throw bad(409, "A knowledge base with this name exists");
  const k = insert(c.s.t.kbs, { org_id: c.org.id, name: B(b).name, description: B(b).description ?? "", sensitivity: B(b).sensitivity ?? "internal", embedding_provider_id: B(b).embedding_provider_id ?? null }); return { id: k.id, name: k.name }; });
r("DELETE", "/knowledge/bases/:id", (c, p) => { const k = find(c.s.t.kbs, c, p.id, "Knowledge base"); remove(c.s.t.kbs, (x) => x.id === k.id); remove(c.s.t.documents, (x) => x.kb_id === k.id); remove(c.s.t.chunks, (x) => x.kb_id === k.id); return { ok: true }; });
r("GET", "/knowledge/bases/:id/documents", (c, p) => c.s.t.documents.filter((d) => d.kb_id === p.id && d.org_id === c.org.id).slice().reverse());
r("POST", "/knowledge/bases/:id/documents", async (c, p, b) => {
  const kb = find(c.s.t.kbs, c, p.id, "Knowledge base"); const file = (b as FormData).get("file") as File;
  if (file.size > 20 * 1024 * 1024) throw bad(413, "Files are limited to 20 MB");
  let text: string; try { text = await extractText(file); } catch (e) { throw bad(415, (e as Error).message); }
  if (!text.trim()) throw bad(422, "No text could be extracted (scanned PDFs need OCR first)");
  const digest = await sha256(text);
  let doc = c.s.t.documents.find((d) => d.kb_id === kb.id && d.filename === file.name);
  if (doc && doc.sha256 === digest) return { id: doc.id, version: doc.version, unchanged: true, chunk_count: doc.chunk_count };
  doc ??= insert(c.s.t.documents, { org_id: c.org.id, kb_id: kb.id, filename: file.name, mime: file.type, version: 0, status: "indexed", error: null });
  Object.assign(doc, { version: Number(doc.version) + 1, size_bytes: file.size, sha256: digest });
  remove(c.s.t.chunks, (x) => x.document_id === doc!.id);
  const chunks = chunkText(text); let emb: number[][] | null = null;
  const prov = kb.embedding_provider_id ? c.s.t.providers.find((x) => x.id === kb.embedding_provider_id) : null;
  if (prov?.embedding_model) { try { emb = await buildProvider(providerCfg(prov)).embed(chunks, prov.embedding_model as string); doc.error = null; } catch (e) { doc.error = `Embedding failed: ${(e as Error).message}`; } }
  chunks.forEach((content, idx) => insert(c.s.t.chunks, { org_id: c.org.id, kb_id: kb.id, document_id: doc!.id, idx, content, embedding: emb?.[idx] ?? null }));
  doc.chunk_count = chunks.length; doc.status = doc.error ? "error" : "indexed";
  audit(c.s, c.org.id, "knowledge.document_uploaded", "document", doc.id, { filename: file.name, version: doc.version }, "user", c.user.email as string); save();
  return { id: doc.id, version: doc.version, chunk_count: doc.chunk_count, status: doc.status, error: doc.error };
});
r("DELETE", "/knowledge/documents/:id", (c, p) => { const d = find(c.s.t.documents, c, p.id, "Document"); remove(c.s.t.documents, (x) => x.id === d.id); remove(c.s.t.chunks, (x) => x.document_id === d.id); return { ok: true }; });
r("POST", "/knowledge/search", async (c, _, b) => (await retrieve(c.s, c.org.id, B(b).kb_ids, B(b).query, B(b).k ?? 5)).map((h) => ({ document: h.filename, document_id: h.document_id, chunk: h.chunk_idx, content: h.content, score: Math.round(h.score * 1e4) / 1e4 })));

// integrations
r("GET", "/providers/presets", () => PRESETS);
r("GET", "/providers", (c) => scoped(c.s.t.providers, c).sort((a, b) => Number(b.is_default) - Number(a.is_default)).map(providerOut));
r("POST", "/providers", (c, _, b) => { const { api_key, ...rest } = B(b); if (scoped(c.s.t.providers, c).some((x) => x.name === rest.name)) throw bad(409, "A model connection with this name already exists");
  if (rest.is_default) scoped(c.s.t.providers, c).forEach((x) => { x.is_default = false; });
  const pr = insert(c.s.t.providers, { org_id: c.org.id, options: {}, ...rest, api_key: api_key?.trim() || null, last_tested_at: null, last_test_ok: null });
  audit(c.s, c.org.id, "provider.created", "llm_provider", pr.id, { kind: pr.kind, name: pr.name }, "user", c.user.email as string); return providerOut(pr); });
r("PATCH", "/providers/:id", (c, p, b) => { const pr = find(c.s.t.providers, c, p.id, "Model connection"); const { api_key, ...rest } = B(b);
  if (rest.is_default) scoped(c.s.t.providers, c).forEach((x) => { x.is_default = false; }); Object.assign(pr, rest); if (api_key) pr.api_key = api_key.trim(); save(); return providerOut(pr); });
r("DELETE", "/providers/:id", (c, p) => { find(c.s.t.providers, c, p.id, "Model connection"); remove(c.s.t.providers, (x) => x.id === p.id); return { ok: true }; });
r("POST", "/providers/:id/test", async (c, p) => { const pr = find(c.s.t.providers, c, p.id, "Model connection"); let ok = true, detail = "";
  try { detail = (await buildProvider(providerCfg(pr)).complete([{ role: "system", content: "You are a connectivity check." }, { role: "user", content: "Reply with the word OK." }], pr.default_model as string, { max_tokens: 20, temperature: 0 })).text.trim().slice(0, 100); }
  catch (e) { ok = false; detail = (e as Error).message.slice(0, 500); }
  pr.last_tested_at = now(); pr.last_test_ok = ok; save(); return { ok, detail }; });
r("GET", "/providers/:id/models", async (c, p) => { try { return { models: await buildProvider(providerCfg(find(c.s.t.providers, c, p.id, "Model connection"))).listModels() }; } catch (e) { throw bad(502, (e as LLMError).message); } });
r("GET", "/connections/types", () => ({ available: CONN_TYPES, planned: ["Email (SMTP) — server edition", "Webhooks — server edition", "Gmail (OAuth)", "Microsoft Outlook (OAuth)", "Slack", "Microsoft Teams", "HubSpot", "Shopify", "Stripe"] }));
r("GET", "/connections", (c) => scoped(c.s.t.connections, c).map(connOut));
r("POST", "/connections", (c, _, b) => { if (!(B(b).kind in CONN_TYPES)) throw NOT_IN_BROWSER("This connection type");
  const x = insert(c.s.t.connections, { org_id: c.org.id, kind: B(b).kind, name: B(b).name, config: B(b).config ?? {}, secret: B(b).secret ?? null, allowed_workflow_ids: B(b).allowed_workflow_ids ?? null, rate_limit_per_minute: B(b).rate_limit_per_minute ?? 30, status: "active" });
  return connOut(x); });
r("PATCH", "/connections/:id", (c, p, b) => { const x = find(c.s.t.connections, c, p.id, "Connection"); const { restrict_workflows, secret, ...rest } = B(b);
  Object.assign(x, rest); if (secret) x.secret = secret; if (restrict_workflows === false) x.allowed_workflow_ids = null; save(); return connOut(x); });
r("DELETE", "/connections/:id", (c, p) => { find(c.s.t.connections, c, p.id, "Connection"); remove(c.s.t.connections, (x) => x.id === p.id); return { ok: true }; });
r("POST", "/connections/:id/test", (c, p) => { const x = find(c.s.t.connections, c, p.id, "Connection"); x.last_tested_at = now(); x.last_test_ok = true; save(); return { ok: true, detail: x.kind === "http_api" ? "Saved. Requests run from your browser, so the API must allow CORS." : "Sandbox connection is ready" }; });
r("GET", "/outbox", (c) => scoped(c.s.t.outbox, c).slice().reverse().slice(0, 200));

// analytics & billing
r("GET", "/analytics/overview", (c) => { const since = new Date(Date.now() - 30 * 86400_000).toISOString(); const ex = scoped(c.s.t.executions, c); const recent = ex.filter((e) => (e.created_at as string) >= since);
  return { active_agents: scoped(c.s.t.agents, c).filter((a) => a.status === "active").length, total_agents: scoped(c.s.t.agents, c).length,
    running: ex.filter((e) => ["queued", "running", "waiting", "awaiting_approval"].includes(e.status as string)).length, completed_30d: recent.filter((e) => e.status === "completed").length, failed_30d: recent.filter((e) => e.status === "failed").length,
    pending_approvals: scoped(c.s.t.approvals, c).filter((a) => a.status === "pending").length, spend_month_usd: spend(c.s, c.org.id), budget_month_usd: c.org.monthly_budget_usd ?? null,
    recent: ex.slice(-8).reverse().map((e) => ({ id: e.id, workflow: (c.s.t.workflows.find((w) => w.id === e.workflow_id)?.name as string) ?? "Agent task", status: e.status, mode: e.mode, created_at: e.created_at, cost_usd: Number(e.cost_usd) })) }; });
r("GET", "/analytics/usage", (c, _, __, q) => { const days = Number(q.get("days") ?? 30); const since = new Date(Date.now() - days * 86400_000).toISOString();
  const u = scoped(c.s.t.usage, c).filter((x) => (x.created_at as string) >= since && (!q.get("agent_id") || x.agent_id === q.get("agent_id")) && (!q.get("workflow_id") || x.workflow_id === q.get("workflow_id")));
  const byDay = new Map<string, { day: string; cost_usd: number; tokens_in: number; tokens_out: number; executions: number }>();
  for (const x of u) { const d = (x.created_at as string).slice(0, 10); const e = byDay.get(d) ?? { day: d, cost_usd: 0, tokens_in: 0, tokens_out: 0, executions: 0 };
    e.cost_usd += Number(x.cost_usd); e.tokens_in += Number(x.tokens_in); e.tokens_out += Number(x.tokens_out); if (x.kind === "execution") e.executions++; byDay.set(d, e); }
  const series = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  const group = (key: string, f: (x: Row) => string) => Object.values(u.filter((x) => x[key]).reduce<Record<string, { k: string; cost: number; n: number; tok: number }>>((a, x) => { const k = f(x); a[k] ??= { k, cost: 0, n: 0, tok: 0 }; a[k].cost += Number(x.cost_usd); a[k].n++; a[k].tok += Number(x.tokens_in) + Number(x.tokens_out); return a; }, {}));
  return { series, by_agent: group("agent_id", (x) => String(c.s.t.agents.find((a) => a.id === x.agent_id)?.name ?? "deleted")).map((g) => ({ agent: g.k, cost_usd: g.cost, calls: g.n })),
    by_model: group("model", (x) => String(x.model)).map((g) => ({ model: g.k, cost_usd: g.cost, tokens: g.tok })),
    totals: { cost_usd: series.reduce((a, s2) => a + s2.cost_usd, 0), tokens: series.reduce((a, s2) => a + s2.tokens_in + s2.tokens_out, 0), executions: series.reduce((a, s2) => a + s2.executions, 0) },
    note: "Costs are calculated from token counts reported by each provider and the prices you entered." }; });
r("GET", "/analytics/agents", (c) => scoped(c.s.t.agents, c).map((a) => { const st = agentStats(c.s, a.id); const ap = scoped(c.s.t.approvals, c).filter((x) => x.requested_by_agent === a.name);
  return { agent_id: a.id, agent: a.name, department: a.department, ...st, error_rate: st.attempted ? Math.round((st.failed / st.attempted) * 1000) / 1000 : null, avg_cost_usd: st.attempted ? st.cost_usd / st.attempted : null,
    tokens: c.s.t.node_executions.filter((n) => (n.input as Record<string, unknown>)?.agent_id === a.id).reduce((x, n) => x + Number(n.tokens_in) + Number(n.tokens_out), 0),
    approval_requests: ap.length, human_corrections: ap.filter((x) => ["rejected", "changes_requested"].includes(x.status as string)).length }; }));
r("GET", "/analytics/export.csv", (c, _, __, q) => {
  const since = new Date(Date.now() - Number(q.get("days") ?? 30) * 86400_000).toISOString();
  const rows = scoped(c.s.t.executions, c).filter((e) => (e.created_at as string) >= since).map((e) => [e.id, c.s.t.workflows.find((w) => w.id === e.workflow_id)?.name ?? "agent task", e.version, e.mode, e.status, e.trigger_type, e.created_at, e.finished_at ?? "", Number(e.cost_usd).toFixed(6), String(e.error ?? "").replace(/\n/g, " ")]);
  return [["execution_id", "workflow", "version", "mode", "status", "trigger", "created_at", "finished_at", "cost_usd", "error"], ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
});
r("GET", "/billing", (c) => ({ plan: "browser", plans: { browser: { label: "Browser edition (free)", agents: null, workflows: null, executions_per_month: null, members: 1, documents: null, integrations: null } },
  status: "active", current_period_end: null, stripe_enabled: false, invoices: [], note: "The browser edition is free and unlimited. AI model costs are billed by your own model provider.",
  usage: { agents: scoped(c.s.t.agents, c).length, workflows: scoped(c.s.t.workflows, c).length, documents: scoped(c.s.t.documents, c).length, members: 1,
    executions_this_month: scoped(c.s.t.executions, c).filter((e) => (e.created_at as string).slice(0, 7) === now().slice(0, 7)).length, ai_cost_this_month_usd: spend(c.s, c.org.id), tokens_in: 0, tokens_out: 0 } }));
r("POST", "/billing/checkout", () => { throw NOT_IN_BROWSER("Paid plans"); });
void PLANS_JSON; void uid;

/* ------------------------------------------------------------------ dispatcher */
const compiled = R.map(([m, path, h]) => { const keys: string[] = []; const re = new RegExp(`^${path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return "([^/]+)"; })}$`); return { m, re, keys, h }; });

async function publicRoute(s: State, method: string, path: string, body: unknown) {
  const b = B(body);
  if (method === "POST" && path === "/auth/register") {
    const email = String(b.email).toLowerCase();
    if (s.t.users.some((u) => u.email === email)) throw bad(409, "An account with this email already exists in this browser");
    const salt = uid(); const user = insert(s.t.users, { email, name: b.name, salt, password_hash: await pbkdf2(String(b.password), salt) });
    const org = seedOrg(s, user, b.company_name); s.session = { user_id: user.id, org_id: org.id }; save();
    return { user: pick(user, ["id", "email", "name"]), org_id: org.id };
  }
  if (method === "POST" && path === "/auth/login") {
    const user = s.t.users.find((u) => u.email === String(b.email).toLowerCase());
    if (!user || (await pbkdf2(String(b.password), user.salt as string)) !== user.password_hash) throw bad(401, "Email or password is incorrect");
    const m = s.t.memberships.find((x) => x.user_id === user.id); s.session = { user_id: user.id, org_id: m?.org_id as string }; save();
    return { mfa_required: false, org_id: m?.org_id ?? null };
  }
  if (method === "POST" && path === "/auth/invitations/accept") throw NOT_IN_BROWSER("Invitations");
  return undefined;
}

export async function handle(method: string, url: string, body: unknown): Promise<{ status: number; data: unknown }> {
  const s = await db();
  startRunner(s);
  const u = new URL(url, "http://local"); const path = u.pathname;
  try {
    const pub = await publicRoute(s, method, path, body);
    if (pub !== undefined) return { status: 200, data: pub };
    const sess = s.session; const user = sess && s.t.users.find((x) => x.id === sess.user_id);
    const org = sess && s.t.orgs.find((x) => x.id === sess.org_id);
    const mem = user && org && s.t.memberships.find((m) => m.user_id === user.id && m.org_id === org.id);
    if (!user || !org || !mem) throw bad(401, "Please sign in");
    for (const rt of compiled) {
      if (rt.m !== method) continue;
      const m = path.match(rt.re); if (!m) continue;
      const params = Object.fromEntries(rt.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const data = await rt.h({ s, user, org, role: mem.role as string }, params, body, u.searchParams);
      save();
      return { status: 200, data };
    }
    throw bad(404, `Not available in the browser edition: ${method} ${path}`);
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, data: (e.data as object) ?? { detail: e.message } };
    console.error(e);
    return { status: 500, data: { detail: (e as Error).message || "Unexpected error" } };
  }
}

export { buildGraph };
