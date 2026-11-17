import { Prose } from "../prose";

export const metadata = { title: "Documentation" };

export default function Docs() {
  return (
    <Prose title="Documentation" lead="Getting started, concepts and API reference.">
      <section><h2>1. Connect an AI model</h2><p>Go to <b>Integrations → AI models</b> and add a provider. AgentOS speaks three protocols: OpenAI-compatible (OpenAI, Azure OpenAI, Mistral, Groq, DeepSeek, OpenRouter, Together, Ollama, vLLM, LM Studio…), Anthropic and Google Gemini. Enter prices per million tokens to enable cost tracking. A sandbox model is included for trying things out offline.</p></section>
      <section><h2>2. Add agents</h2><p>Pick a template from the <b>Agent Marketplace</b> or describe the agent in plain English. Each agent has instructions, an operating mode, an output schema and optional knowledge bases. Every change creates a new version, and you can roll back.</p></section>
      <section><h2>3. Build a workflow</h2><p>In <b>Workflow Studio</b>, drag a trigger, agents and actions onto the canvas and connect them. Reference earlier results with templates such as <code>{"{{ nodes.sales.result.total }}"}</code> or <code>{"{{ trigger.email }}"}</code>. Sending email or calling an API requires an approval step linked to that action.</p></section>
      <section><h2>4. Test, publish, run</h2><p><b>Test run</b> executes the draft with sandbox delivery. <b>Publish</b> creates an immutable version. Running executions always keep the version they started with. Webhook triggers receive a signed URL: sign the raw body with HMAC-SHA256 and send it as <code>X-AgentOS-Signature</code>.</p></section>
      <section><h2>API</h2><p>The full OpenAPI reference is served by every deployment at <a className="text-accent hover:underline" href="/api/docs">/api/docs</a>.</p></section>
    </Prose>
  );
}
