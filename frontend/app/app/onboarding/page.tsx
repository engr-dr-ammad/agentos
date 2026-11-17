"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Bot, Check, ShieldCheck, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Alert, Badge, Button, Card, Field, Input, Select, Textarea } from "@/components/ui";
import { ApiError, patch, post } from "@/lib/api";
import { useMe } from "@/lib/hooks";

const INDUSTRIES = ["Construction", "Manufacturing", "Hospitality", "E-commerce", "Professional services", "Legal", "Logistics", "Healthcare administration", "Education", "Real estate", "Property management", "IT and telecommunications", "Other"];
const SIZES = ["Just me", "2–10", "11–50", "51–250", "251–1000", "1000+"];
type Suggestion = { template_id: string; name: string; description: string; category: string; required_integrations: string[]; approvals: string[]; default_mode: string };

export default function Onboarding() {
  const me = useMe();
  const router = useRouter();
  const qc = useQueryClient();
  const [step, setStep] = useState<1 | 2>(1);
  const [form, setForm] = useState({ industry: "", size: "", country: "", language: "en", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, objective: "", website: "" });
  const [desc, setDesc] = useState("");
  const [sugs, setSugs] = useState<Suggestion[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value });

  const saveCompany = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true);
    try { await patch("/org", { ...form, website: form.website || null }); setStep(2); } catch (er) { toast.error((er as Error).message); } finally { setBusy(false); }
  };
  const ask = async () => {
    setBusy(true);
    try { const s = await post<Suggestion[]>("/onboarding/suggest", { description: desc, industry: form.industry }); setSugs(s); setPicked(new Set(s.slice(0, 4).map((x) => x.template_id))); }
    catch (er) { toast.error((er as Error).message); } finally { setBusy(false); }
  };
  const finish = async (create: boolean) => {
    setBusy(true);
    try {
      let added = 0;
      if (create) for (const id of picked) {
        try { await post("/agents/from-template", { template_id: id }); added++; }
        catch (er) { if ((er as ApiError).status === 402) { toast.warning((er as Error).message); break; } throw er; }
      }
      await patch("/org", { onboarded: true });
      await qc.invalidateQueries();
      toast.success(create ? `${added} agents added as drafts. Review and activate them when ready.` : "Welcome to AgentOS");
      router.push(create ? "/app/workforce" : "/app/marketplace");
    } catch (er) { toast.error((er as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="mx-auto max-w-3xl">
      <p className="text-sm text-text-3">Step {step} of 2</p>
      {step === 1 ? (
        <form onSubmit={saveCompany}>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Tell us about {me.data?.org?.name ?? "your company"}</h1>
          <p className="mt-1 text-sm text-text-2">This helps suggest the right agents. You can change it later in Settings.</p>
          <Card className="mt-6 grid gap-4 p-6 sm:grid-cols-2">
            <Field label="Industry">{(id) => <Select id={id} value={form.industry} onChange={set("industry")} required><option value="">Choose…</option>{INDUSTRIES.map((i) => <option key={i}>{i}</option>)}</Select>}</Field>
            <Field label="Company size">{(id) => <Select id={id} value={form.size} onChange={set("size")}><option value="">Choose…</option>{SIZES.map((i) => <option key={i}>{i}</option>)}</Select>}</Field>
            <Field label="Country">{(id) => <Input id={id} value={form.country} onChange={set("country")} autoComplete="country-name" />}</Field>
            <Field label="Time zone">{(id) => <Input id={id} value={form.timezone} onChange={set("timezone")} />}</Field>
            <Field label="Preferred language">{(id) => <Select id={id} value={form.language} onChange={set("language")}>{[["en", "English"], ["de", "Deutsch"], ["fr", "Français"], ["es", "Español"], ["it", "Italiano"], ["nl", "Nederlands"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>}</Field>
            <Field label="Website (optional)">{(id) => <Input id={id} type="url" placeholder="https://" value={form.website} onChange={set("website")} />}</Field>
            <Field label="Primary business objective" className="sm:col-span-2">{(id) => <Input id={id} placeholder="e.g. respond to customers faster" value={form.objective} onChange={set("objective")} />}</Field>
          </Card>
          <div className="mt-4 flex justify-between"><Button type="button" variant="ghost" onClick={() => setStep(2)}>Skip</Button><Button loading={busy}>Continue</Button></div>
        </form>
      ) : (
        <>
          <h1 className="mt-1 flex items-center gap-2 text-2xl font-semibold tracking-tight"><Sparkles className="h-5 w-5 text-accent" aria-hidden />What would you like your AI workforce to help with?</h1>
          <Card className="mt-6 p-6">
            <Textarea aria-label="Describe what you want help with" rows={4} value={desc} onChange={(e) => setDesc(e.target.value)}
              placeholder="I run a construction company. I want AI to answer enquiries, prepare quotations, organise jobs and remind customers about payments." />
            <div className="mt-3 flex justify-end"><Button onClick={ask} loading={busy && !sugs} disabled={desc.trim().length < 5}>Suggest agents</Button></div>
          </Card>
          {sugs && (
            <div className="mt-6 space-y-3">
              <Alert tone="info">Suggestions are not deployed and receive no permissions until you review, connect apps and activate them.</Alert>
              {sugs.map((s) => {
                const on = picked.has(s.template_id);
                return (
                  <Card key={s.template_id} className={on ? "border-accent" : ""}>
                    <label className="flex cursor-pointer gap-4 p-5">
                      <input type="checkbox" className="mt-1 h-4 w-4 accent-[var(--accent)]" checked={on}
                        onChange={() => { const n = new Set(picked); if (on) n.delete(s.template_id); else n.add(s.template_id); setPicked(n); }} />
                      <div className="flex-1">
                        <div className="flex items-center gap-2"><Bot className="h-4 w-4 text-accent" aria-hidden /><span className="font-medium">{s.name}</span><Badge>{s.category}</Badge></div>
                        <p className="mt-1 text-sm text-text-2">{s.description}</p>
                        <div className="mt-3 grid gap-2 text-xs text-text-2 sm:grid-cols-2">
                          <div><span className="font-medium text-text">Needs: </span>{s.required_integrations.join(", ") || "No external apps"}</div>
                          <div className="flex gap-1"><ShieldCheck className="h-3.5 w-3.5 shrink-0 text-warning" aria-hidden /><span><span className="font-medium text-text">Approvals: </span>{s.approvals.join(", ") || "None by default"}</span></div>
                        </div>
                      </div>
                    </label>
                  </Card>
                );
              })}
              <div className="flex flex-wrap justify-end gap-2 pt-2">
                <Button variant="secondary" onClick={() => finish(false)} disabled={busy}>Customise manually</Button>
                <Button onClick={() => finish(true)} loading={busy} disabled={picked.size === 0}><Check className="h-4 w-4" aria-hidden />Create suggested workspace</Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
