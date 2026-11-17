/**
 * Browser edition storage: one versioned JSON document in IndexedDB.
 * Tables are arrays of plain rows; every row carries org_id so organisations stay separate
 * (all data still lives in this browser profile only).
 */
import { get as idbGet, set as idbSet } from "idb-keyval";

export type Row = { id: string; org_id?: string; created_at: string; [k: string]: unknown };
export type Tables = {
  users: Row[]; orgs: Row[]; memberships: Row[]; providers: Row[]; agents: Row[]; agent_versions: Row[];
  workflows: Row[]; workflow_versions: Row[]; executions: Row[]; node_executions: Row[]; approvals: Row[];
  tasks: Row[]; task_events: Row[]; kbs: Row[]; documents: Row[]; chunks: Row[]; connections: Row[];
  tool_calls: Row[]; outbox: Row[]; crm: Row[]; usage: Row[]; audit: Row[]; schedules: Row[]; jobs: Row[];
  dsr: Row[]; assessments: Row[]; departments: Row[];
};
export type State = { version: 1; session: { user_id: string; org_id: string } | null; t: Tables };

const KEY = "agentos-browser-db-v1";
const empty = (): State => ({
  version: 1, session: null,
  t: { users: [], orgs: [], memberships: [], providers: [], agents: [], agent_versions: [], workflows: [], workflow_versions: [],
    executions: [], node_executions: [], approvals: [], tasks: [], task_events: [], kbs: [], documents: [], chunks: [],
    connections: [], tool_calls: [], outbox: [], crm: [], usage: [], audit: [], schedules: [], jobs: [], dsr: [], assessments: [], departments: [] },
});

let state: State | null = null;
let loading: Promise<State> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export async function db(): Promise<State> {
  if (state) return state;
  loading ??= (async () => {
    let s: State | undefined;
    try { s = await idbGet<State>(KEY); } catch { /* private mode / storage blocked */ }
    state = s && s.version === 1 ? { ...empty(), ...s, t: { ...empty().t, ...s.t } } : empty();
    return state;
  })();
  return loading;
}

/** Debounced persistence; call after every mutation. */
export function save(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { if (state) idbSet(KEY, state).catch(() => { /* quota or blocked */ }); }, 150);
}

export async function flush(): Promise<void> {
  if (saveTimer) clearTimeout(saveTimer);
  if (state) await idbSet(KEY, state);
}

export const uid = () => crypto.randomUUID();
export const now = () => new Date().toISOString();

export function insert<T extends Row>(table: Row[], row: Omit<T, "id" | "created_at"> & Partial<Pick<T, "id" | "created_at">>): T {
  const r = { id: uid(), created_at: now(), ...row } as T;
  table.push(r);
  save();
  return r;
}

export function remove(table: Row[], pred: (r: Row) => boolean): number {
  let n = 0;
  for (let i = table.length - 1; i >= 0; i--) if (pred(table[i])) { table.splice(i, 1); n++; }
  if (n) save();
  return n;
}
