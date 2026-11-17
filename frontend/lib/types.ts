export type AgentConfig = {
  role: string; instructions: string; mode: "draft_only" | "approval_required" | "limited_autonomy" | "controlled_autonomy";
  provider_id: string | null; model: string | null; temperature: number; max_tokens: number;
  output_schema: Record<string, unknown>; knowledge_base_ids: string[]; retrieval_k: number;
};
export type Agent = {
  id: string; name: string; description: string; department: string | null; status: string; current_version: number;
  template_id: string | null; monthly_budget_usd: string | null; escalation_contact: string | null; created_at: string;
  config?: AgentConfig;
  stats?: { attempted: number; completed: number; failed: number; success_rate: number | null; cost_usd: number; avg_seconds: number | null };
  versions?: { version: number; note: string | null; created_at: string; config: AgentConfig }[];
};
export type Template = {
  id: string; name: string; description: string; category: string; industries: string[]; department: string; version: string;
  capabilities: string[]; required_integrations: string[]; inputs: string; outputs: string; safety_constraints: string[];
  permissions: string[]; approvals: string[]; triggers: string[]; default_mode: AgentConfig["mode"]; output_schema: Record<string, unknown>;
};
export type FieldSpec = { key: string; label: string; kind: string; required: boolean; help: string; default: unknown; options: [string, string][] | null; template: boolean };
export type NodeSpec = { category: string; label: string; icon: string; description: string; fields: FieldSpec[]; outputs: string[]; side_effect?: boolean; sensitive?: boolean; connection_kinds?: string[] };
export type FlowNode = { id: string; type: string; position: { x: number; y: number }; data: { label?: string; config?: Record<string, unknown> } };
export type FlowEdge = { id: string; source: string; target: string; sourceHandle?: string | null };
export type Definition = { nodes: FlowNode[]; edges: FlowEdge[] };
export type Workflow = { id: string; name: string; description: string; status: string; published_version: number | null; draft?: Definition; node_count: number; updated_at: string; last_run_at?: string | null; has_webhook?: boolean };
export type NodeRun = { node_id: string; type: string; status: string; attempt: number; output: Record<string, unknown> | null; error: string | null; cost_usd: number; tokens_in: number; tokens_out: number; started_at: string | null; finished_at: string | null; duration_ms: number | null };
export type Execution = { id: string; workflow_id: string | null; workflow_name?: string | null; version: number; mode: string; status: string; trigger_type: string; error: string | null; cost_usd: number; created_at: string; started_at: string | null; finished_at: string | null; input?: unknown; output?: unknown; definition?: Definition; nodes?: NodeRun[]; approvals?: { id: string; node_id: string; status: string }[]; redacted?: boolean };
export type Approval = { id: string; title: string; reason: string; risks: string; payload: { action: string; request: Record<string, unknown> }; payload_hash: string; amount: number | null; currency: string | null; evidence: Record<string, unknown>[]; approver_role: string; requested_by_agent: string | null; status: string; decided_at: string | null; comment: string | null; expires_at: string | null; created_at: string; execution_id: string; workflow_name: string | null; workflow_version: number; can_decide: boolean };
export type Task = { id: string; title: string; description: string; agent_id: string | null; agent_name: string | null; workflow_id: string | null; priority: string; status: string; due_at: string | null; schedule_cron: string | null; inputs: Record<string, unknown>; requires_approval: boolean; result: unknown; cost_usd: number; error: string | null; created_at: string; allowed_transitions: string[]; events?: { from: string | null; to: string; at: string; note: string | null }[]; executions?: { id: string; status: string; created_at: string; cost_usd: number }[] };
export type Provider = { id: string; name: string; kind: string; base_url: string | null; api_key_hint: string | null; has_key: boolean; default_model: string; embedding_model: string | null; is_default: boolean; price_in_per_mtok: string; price_out_per_mtok: string; privacy_tier: string; last_test_ok: boolean | null; last_tested_at: string | null; options: Record<string, unknown> };
export type Connection = { id: string; kind: string; name: string; label: string; config: Record<string, unknown>; has_secret: boolean; allowed_workflow_ids: string[] | null; rate_limit_per_minute: number; status: string; last_test_ok: boolean | null };
export type KB = { id: string; name: string; description: string; sensitivity: string; embedding_provider_id: string | null; documents: number };
export type { Issue } from "./api";
