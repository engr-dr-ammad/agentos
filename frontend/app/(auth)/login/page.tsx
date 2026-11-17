"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Alert, Button, Field, Input } from "@/components/ui";
import { post } from "@/lib/api";

const schema = z.object({ email: z.string().email("Enter a valid email"), password: z.string().min(1, "Enter your password") });

function LoginForm() {
  const router = useRouter();
  const next = useSearchParams().get("next") || "/app";
  const [error, setError] = useState<string>();
  const [mfa, setMfa] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const { register, handleSubmit, formState: { errors } } = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema) });
  const go = () => router.push(next.startsWith("/app") ? next : "/app");

  const onSubmit = handleSubmit(async (v) => {
    setBusy(true); setError(undefined);
    try {
      const r = await post<{ mfa_required: boolean }>("/auth/login", v);
      if (r.mfa_required) setMfa(true); else go();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  });
  const verify = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(undefined);
    try { await post("/auth/mfa/verify", { code }); go(); } catch (er) { setError((er as Error).message); } finally { setBusy(false); }
  };

  if (mfa) return (
    <form onSubmit={verify} className="space-y-4">
      <h1 className="text-lg font-semibold">Two-factor authentication</h1>
      {error && <Alert tone="critical">{error}</Alert>}
      <Field label="6-digit code from your authenticator app">{(id) => <Input id={id} inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} autoFocus />}</Field>
      <Button className="w-full" loading={busy} disabled={code.length !== 6}>Verify</Button>
    </form>
  );
  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <h1 className="text-lg font-semibold">Sign in</h1>
      {error && <Alert tone="critical">{error}</Alert>}
      <Field label="Email" error={errors.email?.message}>{(id) => <Input id={id} type="email" autoComplete="email" {...register("email")} />}</Field>
      <Field label="Password" error={errors.password?.message}>{(id) => <Input id={id} type="password" autoComplete="current-password" {...register("password")} />}</Field>
      <Button className="w-full" loading={busy}>Sign in</Button>
      <p className="text-center text-sm text-text-2">New to AgentOS? <Link href="/register" className="text-accent hover:underline">Create a workspace</Link></p>
    </form>
  );
}

export default function Login() {
  return <Suspense><LoginForm /></Suspense>;
}
