import { Check } from "lucide-react";
import Link from "next/link";
import { buttonClass } from "@/components/button-class";

export const metadata = { title: "Pricing" };
const tiers = [
  { name: "Starter", for: "Sole proprietors and small teams", items: ["5 agents", "3 workflows", "500 executions / month", "3 team members", "Sandbox model and email"] },
  { name: "Business", for: "Growing businesses", items: ["15 agents", "20 workflows", "5,000 executions / month", "Scheduled tasks", "Analytics and CSV export"] },
  { name: "Professional", for: "Multi-agent operations", items: ["50 agents", "100 workflows", "50,000 executions / month", "100 team members", "Advanced approvals"] },
  { name: "Enterprise", for: "Custom requirements", items: ["Custom limits", "Dedicated infrastructure option", "SSO roadmap (SAML / SCIM)", "Data residency options", "Support agreement"] },
];

export default function Pricing() {
  return (
    <div className="mx-auto max-w-6xl px-5 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Pricing</h1>
      <p className="mt-3 max-w-2xl text-text-2">Plans differ by limits and features. Prices are set in the billing system and shown at checkout. AI model usage is billed directly by the model provider you connect, and AgentOS tracks it against your budgets.</p>
      <div className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {tiers.map((t) => (
          <div key={t.name} className="flex flex-col rounded-xl border border-border bg-surface p-6">
            <h2 className="font-semibold">{t.name}</h2><p className="mt-1 text-sm text-text-2">{t.for}</p>
            <ul className="mt-5 flex-1 space-y-2 text-sm">{t.items.map((i) => <li key={i} className="flex gap-2"><Check className="mt-0.5 h-4 w-4 text-good" aria-hidden />{i}</li>)}</ul>
            <Link href={t.name === "Enterprise" ? "/contact" : "/register"} className={`${buttonClass({ variant: t.name === "Business" ? "primary" : "secondary" })} mt-6`}>{t.name === "Enterprise" ? "Contact us" : "Start building"}</Link>
          </div>
        ))}
      </div>
    </div>
  );
}
