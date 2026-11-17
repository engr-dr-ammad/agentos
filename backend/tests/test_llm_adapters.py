"""Wire-format tests for each provider adapter (no network, no paid calls)."""

import json

import httpx
import pytest

from app.llm import base
from app.llm.base import LLMError, Message, ProviderConfig, TransientLLMError
from app.llm.providers import build_provider

pytestmark = pytest.mark.asyncio(loop_scope="session")
MSGS = [Message("system", "Be brief."), Message("user", "Hi")]


@pytest.fixture
def mock_http(monkeypatch):
    seen: list[httpx.Request] = []

    def install(handler):
        def wrapped(request: httpx.Request):
            seen.append(request)
            return handler(request)

        monkeypatch.setattr(base, "_client", httpx.AsyncClient(transport=httpx.MockTransport(wrapped)))
        return seen

    yield install
    monkeypatch.setattr(base, "_client", None)


async def test_openai_compatible(mock_http):
    seen = mock_http(lambda r: httpx.Response(200, json={
        "model": "m", "choices": [{"message": {"content": '{"a":1}'}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 7, "completion_tokens": 3}}))
    p = build_provider(ProviderConfig("openai_compatible", "https://api.example.com/v1", "sk-test"))
    r = await p.complete(MSGS, "m", json_mode=True)
    assert (r.text, r.tokens_in, r.tokens_out) == ('{"a":1}', 7, 3)
    req = seen[0]
    assert str(req.url) == "https://api.example.com/v1/chat/completions"
    assert req.headers["authorization"] == "Bearer sk-test"
    body = json.loads(req.content)
    assert body["response_format"] == {"type": "json_object"} and body["messages"][0]["role"] == "system"


async def test_azure_style_header_and_api_version(mock_http):
    seen = mock_http(lambda r: httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]}))
    p = build_provider(ProviderConfig("openai_compatible", "https://x.openai.azure.com/openai/deployments/d", "k",
                                      {"auth_header": "api-key", "api_version": "2024-10-21"}))
    await p.complete(MSGS, "d")
    assert seen[0].headers["api-key"] == "k" and seen[0].url.params["api-version"] == "2024-10-21"


async def test_json_mode_fallback_for_servers_without_response_format(mock_http):
    def handler(r):
        if "response_format" in json.loads(r.content):
            return httpx.Response(400, json={"error": {"message": "response_format unsupported"}})
        return httpx.Response(200, json={"choices": [{"message": {"content": "{}"}}]})

    seen = mock_http(handler)
    p = build_provider(ProviderConfig("openai_compatible", "http://localhost:11434/v1", None))
    assert (await p.complete(MSGS, "llama3.1", json_mode=True)).text == "{}"
    assert len(seen) == 2 and "authorization" not in seen[0].headers


async def test_anthropic(mock_http):
    seen = mock_http(lambda r: httpx.Response(200, json={
        "model": "claude", "content": [{"type": "text", "text": "hello"}], "stop_reason": "end_turn",
        "usage": {"input_tokens": 5, "output_tokens": 2}}))
    p = build_provider(ProviderConfig("anthropic", None, "ak"))
    r = await p.complete(MSGS, "claude-x")
    assert (r.text, r.tokens_in, r.tokens_out) == ("hello", 5, 2)
    req = seen[0]
    assert str(req.url) == "https://api.anthropic.com/v1/messages"
    assert req.headers["x-api-key"] == "ak" and req.headers["anthropic-version"]
    body = json.loads(req.content)
    assert body["system"] == "Be brief." and body["messages"] == [{"role": "user", "content": "Hi"}]


async def test_gemini(mock_http):
    seen = mock_http(lambda r: httpx.Response(200, json={
        "candidates": [{"content": {"parts": [{"text": "hey"}]}, "finishReason": "STOP"}],
        "usageMetadata": {"promptTokenCount": 4, "candidatesTokenCount": 1}}))
    p = build_provider(ProviderConfig("gemini", None, "gk"))
    r = await p.complete(MSGS, "gemini-2.5-flash", json_mode=True)
    assert (r.text, r.tokens_in) == ("hey", 4)
    req = seen[0]
    assert req.url.path.endswith("/models/gemini-2.5-flash:generateContent")
    assert req.headers["x-goog-api-key"] == "gk"
    body = json.loads(req.content)
    assert body["systemInstruction"]["parts"][0]["text"] == "Be brief."
    assert body["generationConfig"]["responseMimeType"] == "application/json"


async def test_error_classification(mock_http):
    mock_http(lambda r: httpx.Response(429, json={"error": {"message": "slow down"}}))
    p = build_provider(ProviderConfig("openai_compatible", "https://api.example.com/v1", "k"))
    with pytest.raises(TransientLLMError):
        await p.complete(MSGS, "m")
    mock_http(lambda r: httpx.Response(401, json={"error": {"message": "bad key"}}))
    with pytest.raises(LLMError) as ei:
        await p.complete(MSGS, "m")
    assert not isinstance(ei.value, TransientLLMError) and "bad key" in str(ei.value)
