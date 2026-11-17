"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Alert, Button, Field, Input } from "@/components/ui";
import { post } from "@/lib/api";

function Accept() {
  const token = useSearchParams().get("token") ?? "";
  const router = useRouter();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(undefined);
    try {
      const r = await post<{ mfa_required: boolean }>("/auth/invitations/accept", { token, name: name || null, password });
      router.push(r.mfa_required ? "/login" : "/app");
    } catch (er) { setError((er as Error).message); } finally { setBusy(false); }
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <div><h1 className="text-lg font-semibold">Join your team on AgentOS</h1><p className="text-sm text-text-2">New here? Choose a name and password. Already have an account? Enter your existing password.</p></div>
      {!token && <Alert tone="critical">This link is missing its invitation token.</Alert>}
      {error && <Alert tone="critical">{error}</Alert>}
      <Field label="Your name (new accounts)">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
      <Field label="Password">{(id) => <Input id={id} type="password" value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
      <Button className="w-full" loading={busy} disabled={!token || !password}>Accept invitation</Button>
    </form>
  );
}

export default function Invite() {
  return <Suspense><Accept /></Suspense>;
}
