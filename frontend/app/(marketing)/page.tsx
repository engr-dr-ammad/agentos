import { ArrowRight, Bot, Building2, Check, Factory, Gauge, Hammer, Lock, Mail, Scale, ShieldCheck, ShoppingBag, Stethoscope, Utensils, Workflow } from "lucide-react";
import Link from "next/link";
import { buttonClass } from "@/components/button-class";

const steps = [
  ["Describe your business", "Tell AgentOS what you do and what you want help with, in plain English."],
  ["Pick agents from the marketplace", "Ready-made agents for reception, quotations, follow-ups, support and more."],
  ["Drag them into a workflow", "Connect agents, approvals and your apps on a visual canvas."],
  ["Approve what matters", "Emails, quotes and payments wait for a person. Every action is logged."],
];
const agents = [
  ["Receptionist", "Reads enquiries and routes them", "Administration"],
  ["Quotation Agent", "Drafts quotes from your catalogue", "Sales"],
  ["Finance Follow-up", "Prepares payment reminders", "Finance"],
  ["Support Triage", "Classifies tickets and drafts replies", "Customer Support"],
  ["Project Coordinator", "Turns jobs into task lists", "Construction"],
  ["Quality Reporter", "Structures inspection reports", "Manufacturing"],
];
const industries = [
  [Utensils, "Restaurants", "Receptionist, reservation coordinator and inventory agent."],
  [Factory, "Manufacturing", "Quality reporting, production documentation and purchasing drafts."],
  [Scale, "Legal offices", "Document intake and contract organisation with mandatory professional review."],
  [Hammer, "Construction", "Enquiries, quotations, job organisation and payment reminders."],
  [ShoppingBag, "E-commerce", "Order enquiries, returns and catalogue updates."],
  [Stethoscope, "Healthcare admin", "Non-clinical scheduling and administrative intake."],
] as const;
const faqs = [
  ["Do I need to know how to code?", "No. You describe what you need, choose agents and connect them visually. Advanced users can still use webhooks, APIs and JSON schemas."],
  ["Which AI models can I use?", "Bring your own: OpenAI, Anthropic, Google Gemini, Azure OpenAI, Mistral, Groq, DeepSeek, OpenRouter or a self-hosted model such as Ollama or vLLM. You can mix providers per agent."],
  ["Can an agent send an email on its own?", "Not unless you allow it. Sending email, calling external APIs and similar actions require a human approval bound to the exact message, enforced on the server."],
  ["Where is my data?", "Each organisation is isolated at the database level. API keys are encrypted and never shown to the browser or the AI model."],
  ["Is AgentOS compliant with the EU AI Act?", "AgentOS includes a structured AI Act self-assessment and GDPR tools, but a checklist is not a legal determination. High-risk uses require qualified legal review."],
];

function DemoCanvas() {
  const nodes = [
    { x: 4, y: 40, t: "Customer enquiry", k: "Trigger", s: "done" },
    { x: 24, y: 40, t: "Receptionist", k: "AI agent", s: "done" },
    { x: 44, y: 40, t: "Quotation Agent", k: "AI agent", s: "done" },
    { x: 64, y: 40, t: "Manager approval", k: "Approval", s: "wait" },
    { x: 84, y: 40, t: "Send email", k: "Action", s: "idle" },
  ];
  return (
    <figure className="relative overflow-hidden rounded-2xl border border-border bg-surface p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between text-xs text-text-3">
        <span className="font-medium text-text-2">Workflow Studio · Enquiry to quotation</span>
        <span className="rounded-md border border-border px-1.5 py-0.5">Demonstration · simulated data</span>
      </div>
      <div className="relative h-44 rounded-xl bg-bg [background-image:radial-gradient(var(--border)_1px,transparent_1px)] [background-size:16px_16px]">
        <svg className="absolute inset-0 h-full w-full" aria-hidden>
          {nodes.slice(1).map((n, i) => (
            <line key={i} x1={`${nodes[i].x + 13}%`} y1="50%" x2={`${n.x}%`} y2="50%" stroke="var(--text-3)" strokeWidth="2" strokeDasharray={n.s === "idle" ? "4 4" : undefined} />
          ))}
        </svg>
        {nodes.map((n) => (
          <div key={n.t} className={`absolute w-[13%] min-w-24 -translate-y-1/2 rounded-lg border bg-surface px-2 py-1.5 text-[11px] shadow-sm ${n.s === "wait" ? "border-warning" : n.s === "done" ? "border-good/50" : "border-border"}`} style={{ left: `${n.x}%`, top: `${n.y + 10}%` }}>
            <div className="text-text-3">{n.k}</div><div className="truncate font-medium">{n.t}</div>
          </div>
        ))}
      </div>
      <figcaption className="mt-3 flex flex-wrap items-center gap-3 text-xs text-text-2">
        <span className="inline-flex items-center gap-1"><Check className="h-3.5 w-3.5 text-good" aria-hidden /> 3 steps completed</span>
        <span className="inline-flex items-center gap-1"><ShieldCheck className="h-3.5 w-3.5 text-warning" aria-hidden /> Quotation waiting for your approval</span>
        <span className="inline-flex items-center gap-1"><Mail className="h-3.5 w-3.5" aria-hidden /> Email sends only after approval</span>
      </figcaption>
    </figure>
  );
}

export default function Home() {
  return (
    <>
      <section className="mx-auto grid max-w-6xl items-center gap-12 px-5 pb-16 pt-16 lg:grid-cols-[1.05fr_1fr] lg:pt-24">
        <div>
          <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 text-xs text-text-2">
            <Bot className="h-3.5 w-3.5 text-accent" aria-hidden /> Works with the AI model you choose
          </p>
          <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">Your business.<br />Your AI workforce.</h1>
          <p className="mt-5 max-w-xl text-lg text-text-2">Create, connect and manage AI agents that handle everyday business tasks. No coding required.</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/register" className={buttonClass({ size: "lg" })}>Start building <ArrowRight className="h-4 w-4" aria-hidden /></Link>
            <Link href="/#agents" className={buttonClass({ size: "lg", variant: "secondary" })}>Explore AI agents</Link>
          </div>
          <p className="mt-4 text-sm text-text-3">Includes an offline sandbox model, so you can try every feature before adding an API key.</p>
        </div>
        <DemoCanvas />
      </section>

      <section id="how" className="mx-auto max-w-6xl px-5 py-16">
        <h2 className="text-2xl font-semibold tracking-tight">How AgentOS works</h2>
        <ol className="mt-8 grid gap-4 md:grid-cols-4">
          {steps.map(([t, d], i) => (
            <li key={t} className="rounded-xl border border-border bg-surface p-5">
              <span className="text-sm font-semibold text-accent">{String(i + 1).padStart(2, "0")}</span>
              <h3 className="mt-2 font-medium">{t}</h3><p className="mt-1 text-sm text-text-2">{d}</p>
            </li>
          ))}
        </ol>
      </section>

      <section id="agents" className="mx-auto max-w-6xl px-5 py-16">
        <div className="flex items-end justify-between"><h2 className="text-2xl font-semibold tracking-tight">Popular agents</h2>
          <Link href="/register" className="text-sm text-accent hover:underline">See all 16 templates →</Link></div>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {agents.map(([n, d, c]) => (
            <div key={n} className="rounded-xl border border-border bg-surface p-5">
              <div className="flex items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-lg bg-accent-soft text-accent"><Bot className="h-4 w-4" aria-hidden /></span>
                <div><h3 className="font-medium">{n}</h3><p className="text-xs text-text-3">{c}</p></div></div>
              <p className="mt-3 text-sm text-text-2">{d}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl gap-6 px-5 py-16 md:grid-cols-3">
        {[[Workflow, "Visual workflow creation", "Drag agents, conditions, approvals and app actions onto a canvas. Validation explains problems in plain English."],
          [ShieldCheck, "Human approval and control", "Approvals are bound to the exact payload. If the action changes, it needs fresh approval. Agents can never approve themselves."],
          [Gauge, "See what agents do", "Every step, input, output, token and cost is recorded. Budgets stop spending before limits are exceeded."]].map(([I, t, d]) => {
          const Icon = I as typeof Workflow;
          return <div key={t as string} className="rounded-xl border border-border bg-surface p-6"><Icon className="h-5 w-5 text-accent" aria-hidden /><h3 className="mt-3 font-medium">{t as string}</h3><p className="mt-1 text-sm text-text-2">{d as string}</p></div>;
        })}
      </section>

      <section id="industries" className="mx-auto max-w-6xl px-5 py-16">
        <h2 className="text-2xl font-semibold tracking-tight">One platform, many industries</h2>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {industries.map(([Icon, t, d]) => (
            <div key={t} className="flex gap-4 rounded-xl border border-border bg-surface p-5"><Icon className="mt-0.5 h-5 w-5 shrink-0 text-text-2" aria-hidden />
              <div><h3 className="font-medium">{t}</h3><p className="mt-1 text-sm text-text-2">{d}</p></div></div>
          ))}
        </div>
      </section>

      <section id="integrations" className="mx-auto max-w-6xl px-5 py-16">
        <h2 className="text-2xl font-semibold tracking-tight">Integrations</h2>
        <p className="mt-2 max-w-2xl text-text-2">Available today: any SMTP mailbox, webhooks and form submissions, generic REST APIs, a built-in CRM and document knowledge bases. AI models from any major provider or your own servers.</p>
        <div className="mt-6 flex flex-wrap gap-2 text-sm">
          {["SMTP email", "Webhooks", "REST APIs", "Built-in CRM", "PDF / Word / CSV", "OpenAI", "Anthropic", "Google Gemini", "Azure OpenAI", "Mistral", "Groq", "Ollama", "vLLM"].map((i) => <span key={i} className="rounded-lg border border-border bg-surface px-3 py-1.5">{i}</span>)}
          {["Gmail", "Outlook", "Slack", "Teams", "HubSpot", "Shopify", "Stripe"].map((i) => <span key={i} className="rounded-lg border border-dashed border-border px-3 py-1.5 text-text-3">{i} · planned</span>)}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 py-16">
        <div className="grid gap-8 rounded-2xl border border-border bg-surface p-8 md:grid-cols-2">
          <div><Lock className="h-5 w-5 text-accent" aria-hidden /><h2 className="mt-3 text-2xl font-semibold tracking-tight">Security by design</h2>
            <p className="mt-2 text-text-2">Tenant isolation in the database, encrypted credentials, a server-side tool gateway, append-only audit logs, MFA and GDPR request workflows.</p>
            <Link href="/security" className="mt-4 inline-block text-sm text-accent hover:underline">Read the security overview →</Link></div>
          <ul className="space-y-2 text-sm text-text-2">
            {["Permissions are enforced on the server, not by the AI", "Retrieved documents are treated as data, never as instructions", "Duplicate emails and payments are prevented by idempotency keys", "Budgets and rate limits stop runaway spending"].map((t) => <li key={t} className="flex gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-good" aria-hidden />{t}</li>)}
          </ul>
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-5 py-16">
        <h2 className="text-2xl font-semibold tracking-tight">Frequently asked questions</h2>
        <div className="mt-6 divide-y divide-border rounded-xl border border-border bg-surface">
          {faqs.map(([q, a]) => (
            <details key={q} className="group px-5 py-4"><summary className="cursor-pointer list-none font-medium marker:hidden">{q}</summary><p className="mt-2 text-sm text-text-2">{a}</p></details>
          ))}
        </div>
        <div className="mt-12 text-center"><Building2 className="mx-auto h-6 w-6 text-text-3" aria-hidden />
          <p className="mt-2 text-text-2">Ready to give your first agent a job?</p>
          <Link href="/register" className={`${buttonClass({ size: "lg" })} mt-4`}>Start building</Link></div>
      </section>
    </>
  );
}
