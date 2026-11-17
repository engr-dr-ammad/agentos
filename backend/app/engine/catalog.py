"""Typed node catalogue — the single source of truth for the Studio palette, inspector and validator."""

from typing import Any

F = dict[str, Any]


def field(key: str, label: str, kind: str = "text", *, required: bool = False, help: str = "",
          default: Any = None, options: list | None = None, template: bool = False) -> F:
    return {"key": key, "label": label, "kind": kind, "required": required, "help": help,
            "default": default, "options": options, "template": template}


COMMON_ERROR = field("on_error", "If this step fails", "select", default="fail",
                     options=[["fail", "Stop the workflow"], ["continue", "Continue (route to 'error' path)"]])
RETRIES = field("max_attempts", "Max attempts (transient errors)", "number", default=3)
TIMEOUT = field("timeout_seconds", "Timeout (seconds)", "number", default=120)

NODE_TYPES: dict[str, dict[str, Any]] = {
    # ------------------------------------------------------------- triggers
    "trigger.manual": {
        "category": "Triggers", "label": "Manual / form trigger", "icon": "play",
        "description": "Start the workflow by hand, from a task, or via the API.",
        "fields": [field("sample_input", "Sample input (JSON)", "json",
                         help="Used for test runs.", default={"customer_name": "Ada Example"})],
        "outputs": ["default"],
    },
    "trigger.webhook": {
        "category": "Triggers", "label": "Webhook / form submission", "icon": "webhook",
        "description": "Start when an external system or web form POSTs JSON (HMAC-signed).",
        "fields": [field("sample_input", "Sample input (JSON)", "json", default={})], "outputs": ["default"],
    },
    "trigger.schedule": {
        "category": "Triggers", "label": "Schedule", "icon": "clock",
        "description": "Run on a recurring schedule.",
        "fields": [field("cron", "Cron expression", required=True, default="0 9 * * 1",
                         help="e.g. '0 9 * * 1' = every Monday 09:00"),
                   field("timezone", "Time zone", default="UTC")],
        "outputs": ["default"],
    },
    # ------------------------------------------------------------- agents
    "agent": {
        "category": "AI Agents", "label": "AI agent", "icon": "bot",
        "description": "Run one of your AI agents on a clearly stated objective.",
        "fields": [field("agent_id", "Agent", "agent", required=True),
                   field("task", "Objective for this step", "textarea", required=True, template=True,
                         default="Process the incoming request."),
                   field("input", "Input given to the agent", "textarea", template=True,
                         default="{{ trigger }}", help="Only this data is shared with the agent."),
                   TIMEOUT | {"default": 300}, RETRIES, COMMON_ERROR],
        "outputs": ["default", "error"],
    },
    # ------------------------------------------------------------- logic
    "logic.condition": {
        "category": "Conditions", "label": "If / else", "icon": "split",
        "description": "Route to the 'true' or 'false' path.",
        "fields": [field("left", "Value", required=True, template=True),
                   field("op", "Comparison", "select", default="eq", options=[
                       ["eq", "equals"], ["neq", "does not equal"], ["gt", ">"], ["gte", "≥"], ["lt", "<"],
                       ["lte", "≤"], ["contains", "contains"], ["exists", "has a value"],
                       ["truthy", "is true"]]),
                   field("right", "Compare with", template=True)],
        "outputs": ["true", "false"],
    },
    "data.transform": {
        "category": "Data operations", "label": "Transform data", "icon": "shuffle",
        "description": "Build a new object from earlier results.",
        "fields": [field("mapping", "Fields (JSON of name → template)", "json", required=True,
                         default={"summary": "{{ trigger }}"})],
        "outputs": ["default"],
    },
    "data.validate": {
        "category": "Data operations", "label": "Validate data", "icon": "check",
        "description": "Check data against a JSON Schema; route to 'valid' or 'invalid'.",
        "fields": [field("value", "Value to validate", required=True, template=True, default="{{ trigger }}"),
                   field("schema", "JSON Schema", "json", required=True,
                         default={"type": "object", "required": ["email"]})],
        "outputs": ["valid", "invalid"],
    },
    "knowledge.search": {
        "category": "Data operations", "label": "Search knowledge", "icon": "book",
        "description": "Retrieve passages from selected knowledge bases.",
        "fields": [field("kb_ids", "Knowledge bases", "kbs", required=True),
                   field("query", "Search query", required=True, template=True),
                   field("k", "Results", "number", default=5)],
        "outputs": ["default"],
    },
    "finance.price_check": {
        "category": "Data operations", "label": "Pricing rules check", "icon": "calculator",
        "description": "Deterministically compute totals and check pricing rules (no AI involved).",
        "fields": [field("items", "Line items", required=True, template=True,
                         help="List of {description, quantity, unit_price, discount_pct}"),
                   field("currency", "Currency", default="EUR"),
                   field("tax_rate_pct", "Tax rate %", "number", default=19),
                   field("max_discount_pct", "Max discount %", "number", default=15),
                   field("min_unit_price", "Min unit price", "number", default=0),
                   field("max_total", "Max total without escalation", "number")],
        "outputs": ["ok", "violation"],
    },
    # ------------------------------------------------------------- humans
    "human.approval": {
        "category": "Human approvals", "label": "Request approval", "icon": "shield",
        "description": "Pause until an authorised person approves the exact action.",
        "fields": [field("title", "Approval title", required=True, template=True, default="Approve action"),
                   field("action_node", "Action being approved", "node", required=True,
                         help="The approval is bound to this action's exact payload."),
                   field("reason", "Reason shown to approver", "textarea", template=True),
                   field("risks", "Risks", "textarea"),
                   field("amount", "Financial amount", template=True),
                   field("approver_role", "Who can approve", "select", default="manager",
                         options=[["manager", "Manager or above"], ["admin", "Admin or above"],
                                  ["owner", "Owner only"]]),
                   field("expires_hours", "Expires after (hours)", "number", default=72)],
        "outputs": ["default"],
    },
    "human.task": {
        "category": "Human approvals", "label": "Assign task to a person", "icon": "user",
        "description": "Create a task for a team member (non-blocking).",
        "fields": [field("title", "Task title", required=True, template=True),
                   field("description", "Details", "textarea", template=True),
                   field("priority", "Priority", "select", default="normal",
                         options=[["low", "Low"], ["normal", "Normal"], ["high", "High"], ["urgent", "Urgent"]])],
        "outputs": ["default"],
    },
    # ------------------------------------------------------------- actions (through tool gateway)
    "action.send_email": {
        "category": "Actions", "label": "Send email", "icon": "mail", "side_effect": True, "sensitive": True,
        "connection_kinds": ["sandbox_email", "smtp"],
        "description": "Send an email through an authorised connection.",
        "fields": [field("connection_id", "Email connection", "connection", required=True),
                   field("to", "To", required=True, template=True),
                   field("subject", "Subject", required=True, template=True),
                   field("body", "Body", "textarea", required=True, template=True), RETRIES, COMMON_ERROR],
        "outputs": ["default", "error"],
    },
    "action.crm_upsert": {
        "category": "Actions", "label": "Create/update CRM record", "icon": "database", "side_effect": True,
        "connection_kinds": ["sandbox_crm"],
        "description": "Create or update a customer record.",
        "fields": [field("connection_id", "CRM connection", "connection", required=True),
                   field("key", "Record key (e.g. email)", required=True, template=True),
                   field("fields", "Fields (JSON of name → template)", "json", required=True,
                         default={"status": "quoted"}), RETRIES, COMMON_ERROR],
        "outputs": ["default", "error"],
    },
    "action.http_request": {
        "category": "Integrations", "label": "Call approved API", "icon": "globe", "side_effect": True,
        "sensitive": True, "connection_kinds": ["http_api"],
        "description": "Call an approved REST API (host locked to the connection).",
        "fields": [field("connection_id", "API connection", "connection", required=True),
                   field("method", "Method", "select", default="POST",
                         options=[["GET", "GET"], ["POST", "POST"], ["PUT", "PUT"], ["PATCH", "PATCH"],
                                  ["DELETE", "DELETE"]]),
                   field("path", "Path", required=True, template=True, default="/"),
                   field("body", "JSON body", "textarea", template=True), TIMEOUT | {"default": 30}, RETRIES,
                   COMMON_ERROR],
        "outputs": ["default", "error"],
    },
    # ------------------------------------------------------------- control
    "control.delay": {
        "category": "Control flow", "label": "Wait", "icon": "hourglass",
        "description": "Pause for a fixed time (durable — survives restarts).",
        "fields": [field("seconds", "Seconds", "number", required=True, default=60)],
        "outputs": ["default"],
    },
    "control.end": {
        "category": "Control flow", "label": "End", "icon": "flag",
        "description": "Finish and define the workflow result.",
        "fields": [field("result", "Result (JSON of name → template)", "json", default={})],
        "outputs": [],
    },
}

TRIGGERS = {k for k in NODE_TYPES if k.startswith("trigger.")}
SIDE_EFFECTS = {k for k, v in NODE_TYPES.items() if v.get("side_effect")}


def is_mandatory_approval(node_type: str, config: dict) -> bool:
    """Platform-level rule: these actions can never run in production without bound approval."""
    if node_type == "action.http_request":
        return (config.get("method") or "POST").upper() != "GET"
    return bool(NODE_TYPES.get(node_type, {}).get("sensitive")) or bool(config.get("require_approval"))
