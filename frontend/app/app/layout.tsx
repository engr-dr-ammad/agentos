"use client";

import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BarChart3, BookOpen, Bot, ChevronsLeft, ChevronsUpDown, CreditCard, Inbox, LayoutDashboard, ListTodo, LogOut, Moon, Plug,
  Plus, Search, Settings, Store, Sun, Users, Workflow,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { useEffect, useMemo, useState } from "react";
import { EditionBadge } from "@/components/edition";
import { Logo } from "@/components/logo";
import { Input, Loading } from "@/components/ui";
import { get, post } from "@/lib/api";
import { useMe } from "@/lib/hooks";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/app", label: "Overview", icon: LayoutDashboard, keywords: "dashboard home performance" },
  { href: "/app/workforce", label: "My AI Workforce", icon: Bot, keywords: "agents departments" },
  { href: "/app/marketplace", label: "Agent Marketplace", icon: Store, keywords: "templates catalogue" },
  { href: "/app/studio", label: "Workflow Studio", icon: Workflow, keywords: "canvas builder automation" },
  { href: "/app/tasks", label: "Tasks", icon: ListTodo, keywords: "kanban schedule assign" },
  { href: "/app/approvals", label: "Inbox & Approvals", icon: Inbox, keywords: "review handoff" },
  { href: "/app/knowledge", label: "Knowledge Base", icon: BookOpen, keywords: "documents files policies" },
  { href: "/app/integrations", label: "Integrations", icon: Plug, keywords: "models api keys llm email crm" },
  { href: "/app/analytics", label: "Analytics", icon: BarChart3, keywords: "costs usage reports" },
  { href: "/app/team", label: "Team & Access", icon: Users, keywords: "members roles invite" },
  { href: "/app/billing", label: "Billing", icon: CreditCard, keywords: "plan subscription invoices" },
  { href: "/app/settings", label: "Settings", icon: Settings, keywords: "security audit privacy compliance mfa" },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const me = useMe();
  const path = usePathname();
  const router = useRouter();
  const qc = useQueryClient();
  const { resolvedTheme, setTheme } = useTheme();
  const [collapsed, setCollapsed] = useState(false);
  const [q, setQ] = useState("");
  const isStudioEditor = /^\/app\/(studio\/edit|executions\/view)/.test(path);
  const pending = useQuery({ queryKey: ["approvals", "count"], queryFn: () => get<{ pending: number }>("/approvals/count"),
    refetchInterval: 15_000, enabled: !!me.data?.org });

  useEffect(() => {
    // The canvas needs room: collapse automatically in the editor, otherwise remember the user's choice.
    if (isStudioEditor) { setCollapsed(true); return; }
    try { setCollapsed(localStorage.getItem("agentos:nav") === "1"); } catch { /* storage unavailable */ }
  }, [isStudioEditor]);
  const toggle = () => setCollapsed((c) => { try { localStorage.setItem("agentos:nav", c ? "0" : "1"); } catch { /* ignore */ } return !c; });
  const items = useMemo(() => NAV.filter((n) => !q || `${n.label} ${n.keywords}`.toLowerCase().includes(q.toLowerCase())), [q]);

  if (me.isLoading) return <div className="p-10"><Loading rows={4} /></div>;
  if (me.isError || !me.data) return null; // api() redirects to /login on 401
  const { user, org, orgs } = me.data;
  const switchOrg = async (id: string) => { await post("/auth/switch-org", { org_id: id }); qc.clear(); router.push("/app"); };
  const newOrg = async () => {
    const name = window.prompt("Name of the new organisation (e.g. a client workspace)");
    if (name) { await post("/auth/orgs", { name }); qc.clear(); router.push("/app/onboarding"); }
  };
  const signOut = async () => { await post("/auth/logout"); qc.clear(); router.push("/login"); };

  return (
    <div className="flex h-screen overflow-hidden bg-bg">
      <aside className={cn("flex shrink-0 flex-col border-r border-border bg-surface transition-[width]", collapsed ? "w-16" : "w-64")} aria-label="Primary">
        <div className="flex h-14 items-center justify-between px-4">
          {!collapsed && <Link href="/app" className="flex items-center gap-2"><Logo /><EditionBadge compact /></Link>}
          <button onClick={toggle} className="rounded-md p-1.5 text-text-3 hover:bg-surface-2" aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}>
            <ChevronsLeft className={cn("h-4 w-4 transition-transform", collapsed && "rotate-180")} />
          </button>
        </div>
        {!collapsed && (
          <Dropdown.Root>
            <Dropdown.Trigger className="mx-3 mb-2 flex items-center justify-between rounded-lg border border-border px-3 py-2 text-left text-sm hover:bg-surface-2">
              <span className="truncate"><span className="block truncate font-medium">{org?.name ?? "No organisation"}</span>
                <span className="text-xs capitalize text-text-3">{org?.plan} · {org?.role}</span></span>
              <ChevronsUpDown className="h-4 w-4 text-text-3" aria-hidden />
            </Dropdown.Trigger>
            <Dropdown.Portal>
              <Dropdown.Content align="start" sideOffset={4} className="z-50 min-w-56 rounded-lg border border-border bg-surface p-1 text-sm shadow-lg">
                {orgs.map((o) => <Dropdown.Item key={o.id} onSelect={() => switchOrg(o.id)} className="cursor-pointer rounded-md px-2 py-1.5 outline-none data-[highlighted]:bg-surface-2">{o.name}</Dropdown.Item>)}
                <Dropdown.Separator className="my-1 h-px bg-border" />
                <Dropdown.Item onSelect={newOrg} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 outline-none data-[highlighted]:bg-surface-2"><Plus className="h-4 w-4" />New organisation</Dropdown.Item>
              </Dropdown.Content>
            </Dropdown.Portal>
          </Dropdown.Root>
        )}
        {!collapsed && (
          <div className="relative mx-3 mb-2">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-text-3" aria-hidden />
            <Input aria-label="Search navigation" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8" />
          </div>
        )}
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 py-1">
          {items.map(({ href, label, icon: Icon }) => {
            const active = href === "/app" ? path === "/app" : path.startsWith(href);
            const badge = href === "/app/approvals" ? pending.data?.pending : undefined;
            return (
              <Link key={href} href={href} aria-current={active ? "page" : undefined} title={collapsed ? label : undefined}
                className={cn("flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors", active ? "bg-accent-soft font-medium text-accent" : "text-text-2 hover:bg-surface-2 hover:text-text")}>
                <Icon className="h-4 w-4 shrink-0" aria-hidden />
                {!collapsed && <span className="flex-1 truncate">{label}</span>}
                {!collapsed && !!badge && <span className="rounded-full bg-warning/15 px-1.5 text-xs font-medium text-warning">{badge}</span>}
              </Link>
            );
          })}
        </nav>
        <div className="flex items-center gap-2 border-t border-border p-3">
          {!collapsed && <div className="min-w-0 flex-1 text-sm"><p className="truncate font-medium">{user.name}</p><p className="truncate text-xs text-text-3">{user.email}</p></div>}
          <button onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")} className="rounded-md p-1.5 text-text-3 hover:bg-surface-2" aria-label="Toggle dark mode">
            {resolvedTheme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
          <button onClick={signOut} className="rounded-md p-1.5 text-text-3 hover:bg-surface-2" aria-label="Sign out"><LogOut className="h-4 w-4" /></button>
        </div>
      </aside>
      <main id="main" className={cn("flex-1 overflow-y-auto", !isStudioEditor && "px-6 py-8 lg:px-10")}>
        <div className={cn(!isStudioEditor && "mx-auto max-w-7xl")}>{children}</div>
      </main>
    </div>
  );
}
