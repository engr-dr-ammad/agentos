import hashlib
import json
import re
from typing import Any

from .base import (
    LLMError,
    LLMResult,
    Message,
    ProviderConfig,
    get_json,
    post_json,
)


class OpenAICompatible:
    """POST {base_url}/chat/completions — the de-facto standard API."""

    vendor = "OpenAI-compatible API"

    def __init__(self, cfg: ProviderConfig):
        self.base = (cfg.base_url or "https://api.openai.com/v1").rstrip("/")
        self.opts = cfg.options or {}
        self.headers = {"Content-Type": "application/json", **(self.opts.get("headers") or {})}
        if cfg.api_key:
            header = self.opts.get("auth_header") or "Authorization"
            self.headers[header] = f"Bearer {cfg.api_key}" if header.lower() == "authorization" else cfg.api_key
        self.params = {"api-version": self.opts["api_version"]} if self.opts.get("api_version") else None

    async def complete(self, messages: list[Message], model: str, *, temperature: float = 0.2,
                       max_tokens: int = 1024, json_mode: bool = False) -> LLMResult:
        payload: dict[str, Any] = {
            "model": model,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if json_mode and not self.opts.get("no_json_mode"):
            payload["response_format"] = {"type": "json_object"}
        try:
            data = await post_json(f"{self.base}/chat/completions", headers=self.headers, payload=payload,
                                   vendor=self.vendor, params=self.params)
        except LLMError as e:
            # Some compatible servers reject response_format / max_tokens; retry once in plain mode.
            if "HTTP 400" not in str(e) or "response_format" not in payload:
                raise
            payload.pop("response_format")
            data = await post_json(f"{self.base}/chat/completions", headers=self.headers, payload=payload,
                                   vendor=self.vendor, params=self.params)
        try:
            choice = data["choices"][0]
            text = choice["message"].get("content") or ""
        except (KeyError, IndexError, TypeError) as e:
            raise LLMError(f"Unexpected response shape from {self.vendor}") from e
        usage = data.get("usage") or {}
        return LLMResult(text=text, tokens_in=int(usage.get("prompt_tokens") or 0),
                         tokens_out=int(usage.get("completion_tokens") or 0),
                         model=data.get("model") or model, raw_finish=choice.get("finish_reason"))

    async def embed(self, texts: list[str], model: str) -> list[list[float]]:
        data = await post_json(f"{self.base}/embeddings", headers=self.headers,
                               payload={"model": model, "input": texts}, vendor=self.vendor, params=self.params)
        return [d["embedding"] for d in sorted(data["data"], key=lambda d: d["index"])]

    async def list_models(self) -> list[str]:
        data = await get_json(f"{self.base}/models", headers=self.headers, vendor=self.vendor, params=self.params)
        return sorted(m["id"] for m in data.get("data", []) if "id" in m)


class Anthropic:
    vendor = "Anthropic"

    def __init__(self, cfg: ProviderConfig):
        self.base = (cfg.base_url or "https://api.anthropic.com").rstrip("/")
        self.headers = {
            "x-api-key": cfg.api_key or "",
            "anthropic-version": (cfg.options or {}).get("api_version") or "2023-06-01",
            "content-type": "application/json",
        }

    async def complete(self, messages: list[Message], model: str, *, temperature: float = 0.2,
                       max_tokens: int = 1024, json_mode: bool = False) -> LLMResult:
        system = "\n\n".join(m.content for m in messages if m.role == "system")
        if json_mode:
            system += "\n\nRespond with a single JSON object only, no prose or code fences."
        payload = {
            "model": model,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "system": system,
            "messages": [{"role": m.role, "content": m.content} for m in messages if m.role != "system"],
        }
        data = await post_json(f"{self.base}/v1/messages", headers=self.headers, payload=payload, vendor=self.vendor)
        text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
        usage = data.get("usage") or {}
        return LLMResult(text=text, tokens_in=int(usage.get("input_tokens") or 0),
                         tokens_out=int(usage.get("output_tokens") or 0), model=data.get("model") or model,
                         raw_finish=data.get("stop_reason"))

    async def embed(self, texts: list[str], model: str) -> list[list[float]]:
        raise LLMError("Anthropic does not offer an embeddings API; choose another provider for embeddings")

    async def list_models(self) -> list[str]:
        data = await get_json(f"{self.base}/v1/models", headers=self.headers, vendor=self.vendor,
                              params={"limit": 100})
        return [m["id"] for m in data.get("data", [])]


class Gemini:
    vendor = "Google Gemini"

    def __init__(self, cfg: ProviderConfig):
        self.base = (cfg.base_url or "https://generativelanguage.googleapis.com/v1beta").rstrip("/")
        self.headers = {"x-goog-api-key": cfg.api_key or "", "content-type": "application/json"}

    @staticmethod
    def _model_path(model: str) -> str:
        return model if model.startswith("models/") else f"models/{model}"

    async def complete(self, messages: list[Message], model: str, *, temperature: float = 0.2,
                       max_tokens: int = 1024, json_mode: bool = False) -> LLMResult:
        system = "\n\n".join(m.content for m in messages if m.role == "system")
        contents = [
            {"role": "model" if m.role == "assistant" else "user", "parts": [{"text": m.content}]}
            for m in messages if m.role != "system"
        ]
        gen: dict[str, Any] = {"temperature": temperature, "maxOutputTokens": max_tokens}
        if json_mode:
            gen["responseMimeType"] = "application/json"
        payload: dict[str, Any] = {"contents": contents, "generationConfig": gen}
        if system:
            payload["systemInstruction"] = {"parts": [{"text": system}]}
        data = await post_json(f"{self.base}/{self._model_path(model)}:generateContent", headers=self.headers,
                               payload=payload, vendor=self.vendor)
        cands = data.get("candidates") or []
        if not cands:
            reason = (data.get("promptFeedback") or {}).get("blockReason", "no candidates")
            raise LLMError(f"Gemini returned no output ({reason})")
        text = "".join(p.get("text", "") for p in cands[0].get("content", {}).get("parts", []))
        usage = data.get("usageMetadata") or {}
        return LLMResult(text=text, tokens_in=int(usage.get("promptTokenCount") or 0),
                         tokens_out=int(usage.get("candidatesTokenCount") or 0), model=model,
                         raw_finish=cands[0].get("finishReason"))

    async def embed(self, texts: list[str], model: str) -> list[list[float]]:
        mp = self._model_path(model)
        data = await post_json(f"{self.base}/{mp}:batchEmbedContents", headers=self.headers, vendor=self.vendor,
                               payload={"requests": [{"model": mp, "content": {"parts": [{"text": t}]}}
                                                     for t in texts]})
        return [e["values"] for e in data["embeddings"]]

    async def list_models(self) -> list[str]:
        data = await get_json(f"{self.base}/models", headers=self.headers, vendor=self.vendor,
                              params={"pageSize": 200})
        return [m["name"].removeprefix("models/") for m in data.get("models", [])]


class Sandbox:
    """Deterministic offline model. Clearly labelled as simulated output.

    It reads the JSON Schema embedded in the prompt (between <output_schema> tags) and fills it with
    plausible values derived from the input, so workflows can be demonstrated and tested without keys.
    """

    vendor = "Sandbox"

    def __init__(self, cfg: ProviderConfig):
        self.opts = cfg.options or {}

    async def complete(self, messages: list[Message], model: str, *, temperature: float = 0.2,
                       max_tokens: int = 1024, json_mode: bool = False) -> LLMResult:
        prompt = "\n".join(m.content for m in messages)
        if fail := self.opts.get("fail_mode"):
            from .base import TransientLLMError

            raise (TransientLLMError if fail == "transient" else LLMError)("Sandbox simulated failure")
        schema = _between(prompt, "<output_schema>", "</output_schema>")
        user_input = _between(prompt, "<input>", "</input>") or ""
        docs = _between(prompt, "<documents>", "</documents>") or ""
        seed = hashlib.sha256(user_input.encode()).hexdigest()
        try:
            schema_obj = json.loads(schema) if schema else None
        except ValueError:
            schema_obj = None
        try:
            inp = json.loads(user_input) if user_input else {}
        except ValueError:
            inp = {"text": user_input}
        hints = _Hints(user_input, docs)
        out = _fill(schema_obj, inp, seed, hints=hints) if schema_obj else {
            "result": f"[SANDBOX] Simulated response for: {user_input[:200]}"}
        text = json.dumps(out) if (json_mode or schema_obj) else str(out.get("result", out))
        return LLMResult(text=text, tokens_in=len(prompt) // 4, tokens_out=len(text) // 4, model="sandbox-1")

    async def embed(self, texts: list[str], model: str) -> list[list[float]]:
        vecs = []
        for t in texts:
            v = [0.0] * 64
            for w in t.lower().split():
                v[int(hashlib.md5(w.encode(), usedforsecurity=False).hexdigest(), 16) % 64] += 1.0
            n = sum(x * x for x in v) ** 0.5 or 1.0
            vecs.append([x / n for x in v])
        return vecs

    async def list_models(self) -> list[str]:
        return ["sandbox-1"]


def _between(s: str, a: str, b: str) -> str | None:
    i = s.rfind(a)
    if i < 0:
        return None
    j = s.find(b, i + len(a))
    return s[i + len(a): j].strip() if j > 0 else None


def _find(inp: Any, key: str) -> Any:
    if isinstance(inp, dict):
        if key in inp:
            return inp[key]
        for v in inp.values():
            if (r := _find(v, key)) is not None:
                return r
    elif isinstance(inp, list):
        for v in inp:
            if (r := _find(v, key)) is not None:
                return r
    return None


class _Hints:
    """Numbers and lines found in the input and documents, so simulated output looks plausible."""

    def __init__(self, user_input: str, docs: str):
        self.quantities = [int(x) for x in re.findall(r"\b(\d{1,4})\b(?![.,]\d)", user_input)][:20] or [1]
        lines = [ln.strip() for ln in docs.splitlines() if re.search(r"\d+\.\d{2}\b", ln)]
        self.priced_lines = lines[:20]
        self.prices = [float(re.findall(r"(\d+\.\d{2})\b", ln)[-1]) for ln in lines][:20]


def _fill(schema: dict, inp: Any, seed: str, key: str = "", *, hints: "_Hints | None" = None, i: int = 0) -> Any:
    if key and (found := _find(inp, key)) is not None and _type_ok(found, schema):
        return found
    t = schema.get("type")
    k = key.lower()
    if "enum" in schema:
        return schema["enum"][int(seed[:4], 16) % len(schema["enum"])]
    if t == "object" or "properties" in schema:
        return {pk: _fill(v, inp, seed, pk, hints=hints, i=i) for pk, v in (schema.get("properties") or {}).items()}
    if t == "array":
        item = schema.get("items") or {"type": "string"}
        n = max(1, schema.get("minItems", 1))
        if hints and hints.prices and isinstance(item, dict) and "properties" in item:
            n = max(n, min(3, len(hints.prices)))
        return [_fill(item, inp, seed[j:] + seed[:j], key, hints=hints, i=j) for j in range(n)]
    if t in ("number", "integer"):
        if hints and hints.prices and any(w in k for w in ("price", "cost", "amount", "rate")):
            n = hints.prices[i % len(hints.prices)]
        elif hints and any(w in k for w in ("quantity", "qty", "count", "units")):
            n = hints.quantities[i % len(hints.quantities)]
        else:
            n = (int(seed[:6], 16) % 900) + 100
        lo, hi = schema.get("minimum"), schema.get("maximum")
        if lo is not None:
            n = max(n, lo)
        if hi is not None:
            n = min(n, hi)
        return int(n) if t == "integer" else round(float(n), 2)
    if t == "boolean":
        return True
    if hints and hints.priced_lines and k in ("description", "item", "name", "product"):
        return hints.priced_lines[i % len(hints.priced_lines)][:120]
    desc = schema.get("description") or (key.replace("_", " ") if key else "value")
    return f"[SANDBOX] Simulated {desc}"


_PY_TYPES = {"string": str, "object": dict, "array": list, "boolean": bool, "integer": int, "number": (int, float)}


def _type_ok(v: Any, schema: dict) -> bool:
    t = schema.get("type")
    if "enum" in schema:
        return v in schema["enum"]
    if t is None:
        return True
    if isinstance(v, bool) and t in ("integer", "number"):
        return False
    return isinstance(v, _PY_TYPES.get(t, object))


PROVIDERS = {"openai_compatible": OpenAICompatible, "anthropic": Anthropic, "gemini": Gemini, "sandbox": Sandbox}


def build_provider(cfg: ProviderConfig):
    try:
        return PROVIDERS[cfg.kind](cfg)
    except KeyError as e:
        raise LLMError(f"Unknown provider kind: {cfg.kind}") from e
