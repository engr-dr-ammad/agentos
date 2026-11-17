"""Provider-independent LLM interface.

Three wire protocols cover practically every vendor:
  * openai_compatible — OpenAI, Azure OpenAI, Mistral, Groq, DeepSeek, Together, OpenRouter,
                        xAI, Fireworks, Perplexity, Ollama, vLLM, LM Studio, LocalAI …
  * anthropic         — Anthropic Messages API
  * gemini            — Google Gemini API
plus `sandbox`, a deterministic offline model for demos and tests.
"""

from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

import httpx

Role = Literal["system", "user", "assistant"]


@dataclass(slots=True)
class Message:
    role: Role
    content: str


@dataclass(slots=True)
class LLMResult:
    text: str
    tokens_in: int = 0
    tokens_out: int = 0
    model: str = ""
    raw_finish: str | None = None


@dataclass(slots=True)
class ProviderConfig:
    kind: str
    base_url: str | None
    api_key: str | None
    options: dict[str, Any] = field(default_factory=dict)


class LLMError(Exception):
    """Permanent failure (bad request, auth, unsupported feature)."""


class TransientLLMError(LLMError):
    """Retryable failure (rate limit, 5xx, timeout, network)."""


class Provider(Protocol):
    async def complete(self, messages: list[Message], model: str, *, temperature: float = 0.2,
                       max_tokens: int = 1024, json_mode: bool = False) -> LLMResult: ...

    async def embed(self, texts: list[str], model: str) -> list[list[float]]: ...

    async def list_models(self) -> list[str]: ...


_client: httpx.AsyncClient | None = None


def http() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            timeout=httpx.Timeout(120.0, connect=10.0),
            limits=httpx.Limits(max_connections=100, max_keepalive_connections=20),
            follow_redirects=False,
        )
    return _client


def raise_for(resp: httpx.Response, vendor: str) -> None:
    if resp.status_code < 400:
        return
    try:
        body = resp.json()
        detail = body.get("error", body)
        if isinstance(detail, dict):
            detail = detail.get("message") or detail
    except ValueError:
        detail = resp.text[:300]
    msg = f"{vendor} returned HTTP {resp.status_code}: {detail}"
    if resp.status_code in (408, 409, 425, 429) or resp.status_code >= 500:
        raise TransientLLMError(msg)
    raise LLMError(msg)


async def post_json(url: str, *, headers: dict, payload: dict, vendor: str, params: dict | None = None) -> dict:
    try:
        resp = await http().post(url, headers=headers, json=payload, params=params)
    except (httpx.TimeoutException, httpx.NetworkError) as e:
        raise TransientLLMError(f"{vendor} unreachable: {e.__class__.__name__}") from e
    raise_for(resp, vendor)
    return resp.json()


async def get_json(url: str, *, headers: dict, vendor: str, params: dict | None = None) -> dict:
    try:
        resp = await http().get(url, headers=headers, params=params)
    except (httpx.TimeoutException, httpx.NetworkError) as e:
        raise TransientLLMError(f"{vendor} unreachable: {e.__class__.__name__}") from e
    raise_for(resp, vendor)
    return resp.json()
