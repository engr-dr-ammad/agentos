/**
 * Browser edition model adapters. Requests go directly from the browser to the provider.
 * Same three wire protocols as the server edition + the deterministic sandbox model.
 */
export type Msg = { role: "system" | "user" | "assistant"; content: string };
export type LLMResult = { text: string; tokens_in: number; tokens_out: number; model: string };
export type ProviderCfg = { kind: string; base_url: string | null; api_key: string | null; options: Record<string, unknown> };

export class LLMError extends Error {}
export class TransientLLMError extends LLMError {}

async function call(url: string, init: RequestInit, vendor: string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new TransientLLMError(`${vendor} unreachable from the browser (network or CORS): ${(e as Error).message}`);
  }
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* non-JSON */ }
  if (!res.ok) {
    const err = (data.error ?? data) as Record<string, unknown> | string;
    const detail = typeof err === "string" ? err : (err?.message as string) ?? text.slice(0, 300);
    const msg = `${vendor} returned HTTP ${res.status}: ${detail}`;
    if ([408, 409, 425, 429].includes(res.status) || res.status >= 500) throw new TransientLLMError(msg);
    throw new LLMError(msg);
  }
  return data;
}

type Opts = { temperature?: number; max_tokens?: number; json_mode?: boolean };

export interface Provider {
  complete(messages: Msg[], model: string, o?: Opts): Promise<LLMResult>;
  embed(texts: string[], model: string): Promise<number[][]>;
  listModels(): Promise<string[]>;
}

class OpenAICompatible implements Provider {
  base: string; headers: Record<string, string>; q: string;
  constructor(private c: ProviderCfg) {
    this.base = (c.base_url || "https://api.openai.com/v1").replace(/\/$/, "");
    const o = c.options ?? {};
    this.headers = { "content-type": "application/json", ...((o.headers as Record<string, string>) ?? {}) };
    if (c.api_key) {
      const h = (o.auth_header as string) || "Authorization";
      this.headers[h] = h.toLowerCase() === "authorization" ? `Bearer ${c.api_key}` : c.api_key;
    }
    this.q = o.api_version ? `?api-version=${encodeURIComponent(String(o.api_version))}` : "";
  }
  async complete(messages: Msg[], model: string, o: Opts = {}): Promise<LLMResult> {
    const payload: Record<string, unknown> = { model, messages, temperature: o.temperature ?? 0.2, max_tokens: o.max_tokens ?? 1024 };
    if (o.json_mode && !this.c.options?.no_json_mode) payload.response_format = { type: "json_object" };
    const req = () => call(`${this.base}/chat/completions${this.q}`, { method: "POST", headers: this.headers, body: JSON.stringify(payload) }, "OpenAI-compatible API");
    let data: Record<string, unknown>;
    try { data = await req(); } catch (e) {
      if (!(e instanceof LLMError) || e instanceof TransientLLMError || !payload.response_format || !String(e.message).includes("400")) throw e;
      delete payload.response_format;
      data = await req();
    }
    const choice = (data.choices as { message: { content: string } }[] | undefined)?.[0];
    if (!choice) throw new LLMError("Unexpected response from the OpenAI-compatible API");
    const u = (data.usage ?? {}) as Record<string, number>;
    return { text: choice.message.content ?? "", tokens_in: u.prompt_tokens ?? 0, tokens_out: u.completion_tokens ?? 0, model: (data.model as string) ?? model };
  }
  async embed(texts: string[], model: string) {
    const d = await call(`${this.base}/embeddings${this.q}`, { method: "POST", headers: this.headers, body: JSON.stringify({ model, input: texts }) }, "OpenAI-compatible API");
    return (d.data as { index: number; embedding: number[] }[]).sort((a, b) => a.index - b.index).map((x) => x.embedding);
  }
  async listModels() {
    const d = await call(`${this.base}/models${this.q}`, { headers: this.headers }, "OpenAI-compatible API");
    return ((d.data as { id: string }[]) ?? []).map((m) => m.id).sort();
  }
}

class Anthropic implements Provider {
  base: string; headers: Record<string, string>;
  constructor(c: ProviderCfg) {
    this.base = (c.base_url || "https://api.anthropic.com").replace(/\/$/, "");
    this.headers = { "x-api-key": c.api_key ?? "", "anthropic-version": String(c.options?.api_version ?? "2023-06-01"),
      "content-type": "application/json", "anthropic-dangerous-direct-browser-access": "true" };
  }
  async complete(messages: Msg[], model: string, o: Opts = {}) {
    let system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    if (o.json_mode) system += "\n\nRespond with a single JSON object only, no prose or code fences.";
    const d = await call(`${this.base}/v1/messages`, { method: "POST", headers: this.headers, body: JSON.stringify({
      model, system, max_tokens: o.max_tokens ?? 1024, temperature: o.temperature ?? 0.2, messages: messages.filter((m) => m.role !== "system") }) }, "Anthropic");
    const text = ((d.content as { type: string; text?: string }[]) ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
    const u = (d.usage ?? {}) as Record<string, number>;
    return { text, tokens_in: u.input_tokens ?? 0, tokens_out: u.output_tokens ?? 0, model: (d.model as string) ?? model };
  }
  async embed(): Promise<number[][]> { throw new LLMError("Anthropic does not offer an embeddings API"); }
  async listModels() {
    const d = await call(`${this.base}/v1/models?limit=100`, { headers: this.headers }, "Anthropic");
    return ((d.data as { id: string }[]) ?? []).map((m) => m.id);
  }
}

class Gemini implements Provider {
  base: string; headers: Record<string, string>;
  constructor(c: ProviderCfg) {
    this.base = (c.base_url || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
    this.headers = { "x-goog-api-key": c.api_key ?? "", "content-type": "application/json" };
  }
  path = (m: string) => (m.startsWith("models/") ? m : `models/${m}`);
  async complete(messages: Msg[], model: string, o: Opts = {}) {
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const payload: Record<string, unknown> = {
      contents: messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
      generationConfig: { temperature: o.temperature ?? 0.2, maxOutputTokens: o.max_tokens ?? 1024, ...(o.json_mode ? { responseMimeType: "application/json" } : {}) },
    };
    if (system) payload.systemInstruction = { parts: [{ text: system }] };
    const d = await call(`${this.base}/${this.path(model)}:generateContent`, { method: "POST", headers: this.headers, body: JSON.stringify(payload) }, "Google Gemini");
    const c = (d.candidates as { content?: { parts?: { text?: string }[] } }[] | undefined)?.[0];
    if (!c) throw new LLMError("Gemini returned no output");
    const u = (d.usageMetadata ?? {}) as Record<string, number>;
    return { text: (c.content?.parts ?? []).map((p) => p.text ?? "").join(""), tokens_in: u.promptTokenCount ?? 0, tokens_out: u.candidatesTokenCount ?? 0, model };
  }
  async embed(texts: string[], model: string) {
    const mp = this.path(model);
    const d = await call(`${this.base}/${mp}:batchEmbedContents`, { method: "POST", headers: this.headers,
      body: JSON.stringify({ requests: texts.map((t) => ({ model: mp, content: { parts: [{ text: t }] } })) }) }, "Google Gemini");
    return (d.embeddings as { values: number[] }[]).map((e) => e.values);
  }
  async listModels() {
    const d = await call(`${this.base}/models?pageSize=200`, { headers: this.headers }, "Google Gemini");
    return ((d.models as { name: string }[]) ?? []).map((m) => m.name.replace(/^models\//, ""));
  }
}

/* ------------------------------------------------------------------ sandbox (offline, deterministic) */
function hash(s: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  const out = ((h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0"));
  return out.repeat(4);
}
const between = (s: string, a: string, b: string) => { const i = s.lastIndexOf(a); if (i < 0) return null; const j = s.indexOf(b, i + a.length); return j > 0 ? s.slice(i + a.length, j).trim() : null; };

type Schema = { type?: string; properties?: Record<string, Schema>; items?: Schema; enum?: unknown[]; minimum?: number; maximum?: number; minItems?: number; description?: string };
type Hints = { quantities: number[]; prices: number[]; lines: string[] };

function find(inp: unknown, key: string): unknown {
  if (Array.isArray(inp)) { for (const v of inp) { const r = find(v, key); if (r !== undefined) return r; } return undefined; }
  if (inp && typeof inp === "object") {
    const o = inp as Record<string, unknown>;
    if (key in o) return o[key];
    for (const v of Object.values(o)) { const r = find(v, key); if (r !== undefined) return r; }
  }
  return undefined;
}
function typeOk(v: unknown, s: Schema) {
  if (s.enum) return s.enum.includes(v);
  switch (s.type) {
    case "string": return typeof v === "string"; case "object": return !!v && typeof v === "object" && !Array.isArray(v);
    case "array": return Array.isArray(v); case "boolean": return typeof v === "boolean";
    case "integer": return Number.isInteger(v); case "number": return typeof v === "number"; default: return true;
  }
}
function fill(s: Schema, inp: unknown, seed: string, key: string, h: Hints, i = 0): unknown {
  if (key) { const f = find(inp, key); if (f !== undefined && f !== null && typeOk(f, s)) return f; }
  const k = key.toLowerCase();
  if (s.enum) return s.enum[parseInt(seed.slice(0, 4), 16) % s.enum.length];
  if (s.type === "object" || s.properties) return Object.fromEntries(Object.entries(s.properties ?? {}).map(([pk, v]) => [pk, fill(v, inp, seed, pk, h, i)]));
  if (s.type === "array") {
    const item = s.items ?? { type: "string" };
    let n = Math.max(1, s.minItems ?? 1);
    if (h.prices.length && item.properties) n = Math.max(n, Math.min(3, h.prices.length));
    return Array.from({ length: n }, (_, j) => fill(item, inp, seed.slice(j) + seed.slice(0, j), key, h, j));
  }
  if (s.type === "number" || s.type === "integer") {
    let n = (parseInt(seed.slice(0, 6), 16) % 900) + 100;
    if (h.prices.length && /price|cost|amount|rate/.test(k)) n = h.prices[i % h.prices.length];
    else if (/quantity|qty|count|units/.test(k)) n = h.quantities[i % h.quantities.length];
    if (s.minimum != null) n = Math.max(n, s.minimum);
    if (s.maximum != null) n = Math.min(n, s.maximum);
    return s.type === "integer" ? Math.round(n) : Math.round(n * 100) / 100;
  }
  if (s.type === "boolean") return true;
  if (h.lines.length && ["description", "item", "name", "product"].includes(k)) return h.lines[i % h.lines.length].slice(0, 120);
  return `[SANDBOX] Simulated ${s.description ?? (key ? key.replace(/_/g, " ") : "value")}`;
}

class Sandbox implements Provider {
  constructor(private c: ProviderCfg) {}
  async complete(messages: Msg[]): Promise<LLMResult> {
    const prompt = messages.map((m) => m.content).join("\n");
    const fail = this.c.options?.fail_mode;
    if (fail) throw new (fail === "transient" ? TransientLLMError : LLMError)("Sandbox simulated failure");
    const schemaText = between(prompt, "<output_schema>", "</output_schema>");
    const input = between(prompt, "<input>", "</input>") ?? "";
    const docs = between(prompt, "<documents>", "</documents>") ?? "";
    let schema: Schema | null = null, inp: unknown = {};
    try { schema = schemaText ? JSON.parse(schemaText) : null; } catch { /* ignore */ }
    try { inp = input ? JSON.parse(input) : {}; } catch { inp = { text: input }; }
    const lines = docs.split("\n").map((l) => l.trim()).filter((l) => /\d+\.\d{2}\b/.test(l));
    const h: Hints = {
      quantities: [...input.matchAll(/\b(\d{1,4})\b(?![.,]\d)/g)].map((m) => Number(m[1])).slice(0, 20),
      prices: lines.map((l) => Number([...l.matchAll(/(\d+\.\d{2})\b/g)].pop()![1])).slice(0, 20), lines: lines.slice(0, 20),
    };
    if (!h.quantities.length) h.quantities = [1];
    const out = schema ? fill(schema, inp, hash(input), "", h) : { result: `[SANDBOX] Simulated response for: ${input.slice(0, 200)}` };
    const text = JSON.stringify(out);
    await new Promise((r) => setTimeout(r, 250)); // make runs visibly animate
    return { text, tokens_in: Math.floor(prompt.length / 4), tokens_out: Math.floor(text.length / 4), model: "sandbox-1" };
  }
  async embed(texts: string[]) {
    return texts.map((t) => {
      const v = new Array(64).fill(0);
      for (const w of t.toLowerCase().split(/\s+/)) if (w) v[parseInt(hash(w).slice(0, 6), 16) % 64] += 1;
      const n = Math.hypot(...v) || 1;
      return v.map((x) => x / n);
    });
  }
  async listModels() { return ["sandbox-1"]; }
}

export function buildProvider(c: ProviderCfg): Provider {
  switch (c.kind) {
    case "openai_compatible": return new OpenAICompatible(c);
    case "anthropic": return new Anthropic(c);
    case "gemini": return new Gemini(c);
    case "sandbox": return new Sandbox(c);
    default: throw new LLMError(`Unknown provider kind: ${c.kind}`);
  }
}
