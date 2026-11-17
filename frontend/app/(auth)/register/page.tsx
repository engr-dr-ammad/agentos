"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Alert, Button, Field, Input } from "@/components/ui";
import { post } from "@/lib/api";

const schema = z.object({
  name: z.string().min(1, "Enter your name"),
  company_name: z.string().min(1, "Enter your company name"),
  email: z.string().email("Enter a valid email"),
  password: z.string().min(10, "At least 10 characters").regex(/[A-Za-z]/, "Include a letter").regex(/\d/, "Include a number"),
});

export default function Register() {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema) });
  const onSubmit = handleSubmit(async (v) => {
    setError(undefined);
    try { await post("/auth/register", v); router.push("/app/onboarding"); } catch (e) { setError((e as Error).message); }
  });
  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <div><h1 className="text-lg font-semibold">Create your workspace</h1><p className="text-sm text-text-2">Free to start. No credit card.</p></div>
      {error && <Alert tone="critical">{error}</Alert>}
      <Field label="Your name" error={errors.name?.message}>{(id) => <Input id={id} autoComplete="name" {...register("name")} />}</Field>
      <Field label="Company name" error={errors.company_name?.message}>{(id) => <Input id={id} autoComplete="organization" {...register("company_name")} />}</Field>
      <Field label="Work email" error={errors.email?.message}>{(id) => <Input id={id} type="email" autoComplete="email" {...register("email")} />}</Field>
      <Field label="Password" error={errors.password?.message} help="At least 10 characters with letters and numbers">{(id) => <Input id={id} type="password" autoComplete="new-password" {...register("password")} />}</Field>
      <Button className="w-full" loading={isSubmitting}>Create workspace</Button>
      <p className="text-center text-xs text-text-3">By continuing you agree to the <Link href="/legal/terms" className="underline">terms</Link> and <Link href="/legal/privacy" className="underline">privacy policy</Link>.</p>
      <p className="text-center text-sm text-text-2">Already have an account? <Link href="/login" className="text-accent hover:underline">Sign in</Link></p>
    </form>
  );
}
