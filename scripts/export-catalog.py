"""Export the node catalogue, agent templates and plans as JSON for the browser edition.

Single source of truth stays in the backend; run after changing them:
    backend/.venv/bin/python scripts/export-catalog.py
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.engine.catalog import NODE_TYPES  # noqa: E402
from app.plans import PLANS  # noqa: E402
from app.templates_registry import TEMPLATES  # noqa: E402

out = ROOT / "frontend" / "lib" / "local" / "data"
out.mkdir(parents=True, exist_ok=True)
(out / "node-types.json").write_text(json.dumps(NODE_TYPES, indent=1))
(out / "templates.json").write_text(json.dumps([t.model_dump() for t in TEMPLATES.values()], indent=1))
(out / "plans.json").write_text(json.dumps(PLANS, indent=1))
print(f"wrote catalogue to {out}")
