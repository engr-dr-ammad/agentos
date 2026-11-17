import Link from "next/link";
import { Logo } from "@/components/logo";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main id="main" className="flex min-h-screen flex-col items-center justify-center bg-bg px-4 py-12">
      <Link href="/" className="mb-8" aria-label="AgentOS home"><Logo className="text-lg" /></Link>
      <div className="w-full max-w-sm rounded-2xl border border-border bg-surface p-6 shadow-sm">{children}</div>
    </main>
  );
}
