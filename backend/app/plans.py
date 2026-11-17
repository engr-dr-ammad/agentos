"""Plan limits. Commercial prices live in Stripe (price IDs via env), never in code."""

PLANS: dict[str, dict] = {
    "starter": {"label": "Starter", "agents": 5, "workflows": 3, "executions_per_month": 500,
                "members": 3, "documents": 50, "integrations": 3},
    "business": {"label": "Business", "agents": 15, "workflows": 20, "executions_per_month": 5_000,
                 "members": 15, "documents": 1_000, "integrations": 15},
    "professional": {"label": "Professional", "agents": 50, "workflows": 100, "executions_per_month": 50_000,
                     "members": 100, "documents": 10_000, "integrations": 50},
    "enterprise": {"label": "Enterprise", "agents": None, "workflows": None, "executions_per_month": None,
                   "members": None, "documents": None, "integrations": None},
}


def limit(plan: str, key: str) -> int | None:
    return PLANS.get(plan, PLANS["starter"])[key]
