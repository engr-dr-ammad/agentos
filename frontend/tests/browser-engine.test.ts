import { afterEach, describe, expect, it, vi } from "vitest";
import { priceCheck, render, referencedNodes } from "@/lib/local/engine";
import { buildProvider } from "@/lib/local/llm";

describe("browser edition engine", () => {
  it("prices deterministically, identical to the server edition", () => {
    const out = priceCheck([{ description: "Chair", quantity: 3, unit_price: "19.99", discount_pct: 10 }, { description: "Desk", quantity: 1, unit_price: 100, discount_pct: 20 }],
      { tax_rate_pct: 19, max_discount_pct: 15 });
    expect([out.subtotal, out.discount_total, out.net, out.tax, out.total]).toEqual(["159.97", "26.00", "133.97", "25.45", "159.42"]);
    expect(out.ok).toBe(false);
  });
  it("renders Jinja-style templates, including native values and loops", () => {
    const ctx = { trigger: { email: "a@b.co" }, nodes: { p: { lines: [{ d: "x" }, { d: "y" }], total: "9.50" } } };
    expect(render("{{ nodes.p.lines }}", ctx)).toEqual([{ d: "x" }, { d: "y" }]);
    expect(render("{% for l in nodes.p.lines %}{{ l.d }}{% endfor %} = {{ nodes.p.total }}", ctx)).toBe("xy = 9.50");
    expect(() => render("{{ nodes.missing.value }}", ctx)).toThrow(/missing data/);
    expect([...referencedNodes({ a: "{{ nodes.sales.result }}", b: "{% for x in nodes['p'].lines %}{% endfor %}" }).refs].sort()).toEqual(["p", "sales"]);
  });
});

describe("browser edition model adapters", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("calls Anthropic directly from the browser with the required header", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ content: [{ type: "text", text: "OK" }], usage: { input_tokens: 3, output_tokens: 1 } })));
    vi.stubGlobal("fetch", fetch);
    const r = await buildProvider({ kind: "anthropic", base_url: null, api_key: "k", options: {} }).complete([{ role: "user", content: "hi" }], "claude-x");
    expect(r.text).toBe("OK");
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((init.headers as Record<string, string>)["anthropic-dangerous-direct-browser-access"]).toBe("true");
  });
  it("sends OpenAI-compatible requests with a bearer token and JSON mode", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })));
    vi.stubGlobal("fetch", fetch);
    await buildProvider({ kind: "openai_compatible", base_url: "https://api.example.com/v1", api_key: "sk", options: {} }).complete([{ role: "user", content: "hi" }], "m", { json_mode: true });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk");
    expect(JSON.parse(init.body as string).response_format).toEqual({ type: "json_object" });
  });
});
