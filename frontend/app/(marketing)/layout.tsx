import Link from "next/link";
import { Logo } from "@/components/logo";
import { buttonClass } from "@/components/button-class";

const nav = [["Product", "/#how"], ["Agents", "/#agents"], ["Industries", "/#industries"], ["Integrations", "/#integrations"],
  ["Pricing", "/pricing"], ["Security", "/security"], ["Docs", "/docs"]];

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-bg">
      <header className="sticky top-0 z-40 border-b border-border bg-bg/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-5">
          <Link href="/" aria-label="AgentOS home"><Logo /></Link>
          <nav aria-label="Main" className="hidden gap-6 text-sm text-text-2 md:flex">
            {nav.map(([l, h]) => <Link key={h} href={h} className="hover:text-text">{l}</Link>)}
          </nav>
          <div className="flex gap-2">
            <Link href="/login" className={buttonClass({ variant: "ghost", size: "sm" })}>Sign in</Link>
            <Link href="/register" className={buttonClass({ size: "sm" })}>Start building</Link>
          </div>
        </div>
      </header>
      <main id="main">{children}</main>
      <footer className="mt-24 border-t border-border">
        <div className="mx-auto grid max-w-6xl gap-8 px-5 py-10 text-sm text-text-2 md:grid-cols-4">
          <div><Logo /><p className="mt-2 text-text-3">Build your AI workforce visually. Give every agent a job. Stay in control.</p></div>
          <div className="space-y-2"><p className="font-medium text-text">Product</p><Link href="/#how" className="block hover:text-text">How it works</Link><Link href="/pricing" className="block hover:text-text">Pricing</Link><Link href="/docs" className="block hover:text-text">Documentation</Link></div>
          <div className="space-y-2"><p className="font-medium text-text">Trust</p><Link href="/security" className="block hover:text-text">Security & privacy</Link><Link href="/legal/privacy" className="block hover:text-text">Privacy policy</Link><Link href="/legal/terms" className="block hover:text-text">Terms</Link></div>
          <div className="space-y-2"><p className="font-medium text-text">Company</p><Link href="/contact" className="block hover:text-text">Contact & demo</Link></div>
        </div>
      </footer>
    </div>
  );
}
