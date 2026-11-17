"""Safe templating for node configuration.

Templates use Jinja syntax in a sandbox: `{{ trigger.email }}`, `{{ nodes.sales.result.total }}`.
A template that is exactly one expression (`{{ expr }}`) evaluates to the native value (list, dict,
number) rather than a string.
"""

import json
import re
from functools import lru_cache
from typing import Any

from jinja2 import StrictUndefined, TemplateSyntaxError, UndefinedError, nodes
from jinja2.sandbox import ImmutableSandboxedEnvironment

_env = ImmutableSandboxedEnvironment(undefined=StrictUndefined, autoescape=False)
_env.filters["json"] = lambda v: json.dumps(v, default=str, ensure_ascii=False)
_SINGLE = re.compile(r"^\s*\{\{(.+?)\}\}\s*$", re.S)
MAX_RENDER = 200_000


class TemplateError(ValueError):
    pass


@lru_cache(maxsize=2048)
def _compile(src: str):
    return _env.from_string(src)


@lru_cache(maxsize=2048)
def _compile_expr(expr: str):
    return _env.compile_expression(expr, undefined_to_none=False)


def render(src: Any, ctx: dict) -> Any:
    """Render a string template; recurse into dicts/lists; pass other values through."""
    if isinstance(src, dict):
        return {k: render(v, ctx) for k, v in src.items()}
    if isinstance(src, list):
        return [render(v, ctx) for v in src]
    if not isinstance(src, str) or "{" not in src:
        return src
    try:
        if (m := _SINGLE.match(src)) and "}}" not in m.group(1):
            return _compile_expr(m.group(1).strip())(**ctx)
        out = _compile(src).render(**ctx)
    except UndefinedError as e:
        raise TemplateError(f"Template refers to missing data: {e.message}") from e
    except TemplateSyntaxError as e:
        raise TemplateError(f"Template syntax error: {e.message}") from e
    except Exception as e:  # sandbox security errors, type errors
        raise TemplateError(f"Template error: {e}") from e
    if len(out) > MAX_RENDER:
        raise TemplateError("Rendered value is too large")
    return out


def render_str(src: Any, ctx: dict) -> str:
    v = render(src, ctx)
    return v if isinstance(v, str) else json.dumps(v, default=str, ensure_ascii=False)


def referenced_nodes(src: Any) -> tuple[set[str], list[str]]:
    """Return ({node ids referenced via nodes.X / nodes['X']}, [syntax errors])."""
    refs: set[str] = set()
    errors: list[str] = []
    stack = [src]
    while stack:
        v = stack.pop()
        if isinstance(v, dict):
            stack.extend(v.values())
        elif isinstance(v, list):
            stack.extend(v)
        elif isinstance(v, str) and "{" in v:
            try:
                ast = _env.parse(v)
            except TemplateSyntaxError as e:
                errors.append(e.message or "syntax error")
                continue
            for n in ast.find_all((nodes.Getattr, nodes.Getitem)):
                if isinstance(n.node, nodes.Name) and n.node.name == "nodes":
                    if isinstance(n, nodes.Getattr):
                        refs.add(n.attr)
                    elif isinstance(n.arg, nodes.Const):
                        refs.add(str(n.arg.value))
    return refs, errors
