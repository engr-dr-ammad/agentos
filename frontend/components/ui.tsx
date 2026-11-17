"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { type VariantProps } from "class-variance-authority";
import { buttonClass } from "./button-class";
import { AlertTriangle, CheckCircle2, CircleDashed, Clock, Info, Loader2, PauseCircle, ShieldAlert, X, XCircle } from "lucide-react";
import { forwardRef, useId, type ComponentProps, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/* ---------------------------------------------------------------- Button */
type ButtonProps = ComponentProps<"button"> & VariantProps<typeof buttonClass> & { loading?: boolean };
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, loading, children, disabled, ...p }, ref) {
  return (
    <button ref={ref} className={cn(buttonClass({ variant, size }), className)} disabled={disabled || loading} aria-busy={loading} {...p}>
      {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
});
export { buttonClass } from "./button-class";

/* ---------------------------------------------------------------- Form controls */
const control = "w-full rounded-lg border border-border bg-surface px-3 text-sm text-text placeholder:text-text-3 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 disabled:opacity-60";

export const Input = forwardRef<HTMLInputElement, ComponentProps<"input">>(function Input({ className, ...p }, ref) {
  return <input ref={ref} className={cn(control, "h-9", className)} {...p} />;
});
export const Textarea = forwardRef<HTMLTextAreaElement, ComponentProps<"textarea">>(function Textarea({ className, ...p }, ref) {
  return <textarea ref={ref} className={cn(control, "min-h-20 py-2 leading-relaxed", className)} {...p} />;
});
export const Select = forwardRef<HTMLSelectElement, ComponentProps<"select">>(function Select({ className, ...p }, ref) {
  return <select ref={ref} className={cn(control, "h-9 pr-8", className)} {...p} />;
});

export function Field({ label, help, error, children, className }: {
  label: string; help?: ReactNode; error?: string; children: (id: string) => ReactNode; className?: string;
}) {
  const id = useId();
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={id} className="block text-sm font-medium text-text">{label}</label>
      {children(id)}
      {error ? <p className="text-xs text-critical" role="alert">{error}</p> : help ? <p className="text-xs text-text-3">{help}</p> : null}
    </div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}
      className={cn("relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors", checked ? "bg-accent" : "bg-border")}>
      <span className={cn("inline-block h-4 w-4 rounded-full bg-white shadow transition-transform", checked ? "translate-x-4.5" : "translate-x-0.5")} />
    </button>
  );
}

/* ---------------------------------------------------------------- Layout */
export function Card({ className, ...p }: ComponentProps<"div">) {
  return <div className={cn("rounded-xl border border-border bg-surface", className)} {...p} />;
}
export function CardHeader({ title, description, action }: { title: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
      <div><h2 className="text-sm font-semibold">{title}</h2>{description && <p className="mt-0.5 text-sm text-text-2">{description}</p>}</div>
      {action}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-text-2">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border px-6 py-14 text-center">
      {icon && <div className="mb-3 text-text-3">{icon}</div>}
      <h3 className="font-medium">{title}</h3>
      {description && <p className="mt-1 max-w-md text-sm text-text-2">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-lg bg-surface-2", className)} aria-hidden />;
}
export function Loading({ rows = 3 }: { rows?: number }) {
  return <div className="space-y-3" role="status" aria-label="Loading">{Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-16" />)}</div>;
}

export function Alert({ tone = "info", title, children }: { tone?: "info" | "warning" | "critical" | "good"; title?: string; children?: ReactNode }) {
  const Icon = { info: Info, warning: AlertTriangle, critical: XCircle, good: CheckCircle2 }[tone];
  const color = { info: "text-accent", warning: "text-warning", critical: "text-critical", good: "text-good" }[tone];
  return (
    <div className="flex gap-3 rounded-lg border border-border bg-surface-2 px-4 py-3 text-sm" role={tone === "critical" ? "alert" : "status"}>
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", color)} aria-hidden />
      <div>{title && <p className="font-medium">{title}</p>}<div className="text-text-2">{children}</div></div>
    </div>
  );
}

/* ---------------------------------------------------------------- Badges */
export function Badge({ className, tone = "neutral", ...p }: ComponentProps<"span"> & { tone?: "neutral" | "accent" | "good" | "warning" | "critical" }) {
  const tones = {
    neutral: "bg-surface-2 text-text-2 border-border",
    accent: "bg-accent-soft text-accent border-transparent",
    good: "bg-good/10 text-good border-transparent",
    warning: "bg-warning/10 text-warning border-transparent",
    critical: "bg-critical/10 text-critical border-transparent",
  };
  return <span className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium", tones[tone], className)} {...p} />;
}

const STATUS: Record<string, { tone: "neutral" | "accent" | "good" | "warning" | "critical"; icon: typeof Clock; label?: string }> = {
  completed: { tone: "good", icon: CheckCircle2 }, active: { tone: "good", icon: CheckCircle2 },
  approved: { tone: "good", icon: CheckCircle2 }, succeeded: { tone: "good", icon: CheckCircle2 },
  running: { tone: "accent", icon: Loader2 }, queued: { tone: "neutral", icon: Clock }, retrying: { tone: "warning", icon: Loader2 },
  waiting: { tone: "neutral", icon: Clock }, awaiting_approval: { tone: "warning", icon: ShieldAlert, label: "awaiting approval" },
  pending: { tone: "warning", icon: ShieldAlert }, paused: { tone: "neutral", icon: PauseCircle },
  failed: { tone: "critical", icon: XCircle }, failed_continued: { tone: "warning", icon: AlertTriangle, label: "failed (continued)" },
  rejected: { tone: "critical", icon: XCircle }, cancelled: { tone: "neutral", icon: X }, expired: { tone: "neutral", icon: Clock },
  changes_requested: { tone: "warning", icon: AlertTriangle, label: "changes requested" },
  draft: { tone: "neutral", icon: CircleDashed }, disabled: { tone: "neutral", icon: X }, skipped: { tone: "neutral", icon: CircleDashed },
  revoked: { tone: "critical", icon: X },
};
export function StatusBadge({ status }: { status: string }) {
  const key = status.toLowerCase().replace(/ /g, "_");
  const s = STATUS[key] ?? { tone: "neutral" as const, icon: CircleDashed };
  const Icon = s.icon;
  return <Badge tone={s.tone}><Icon className={cn("h-3 w-3", key === "running" && "animate-spin")} aria-hidden />{s.label ?? status.replace(/_/g, " ")}</Badge>;
}

/* ---------------------------------------------------------------- Dialog / Drawer */
export function Dialog({ open, onOpenChange, title, description, children, footer, wide }: {
  open: boolean; onOpenChange: (v: boolean) => void; title: string; description?: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[1px]" />
        <DialogPrimitive.Content className={cn("fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-surface shadow-xl", wide ? "max-w-3xl" : "max-w-lg")}>
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div>
              <DialogPrimitive.Title className="font-semibold">{title}</DialogPrimitive.Title>
              {description ? <DialogPrimitive.Description className="mt-1 text-sm text-text-2">{description}</DialogPrimitive.Description>
                : <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>}
            </div>
            <DialogPrimitive.Close className="rounded-md p-1 text-text-3 hover:bg-surface-2" aria-label="Close"><X className="h-4 w-4" /></DialogPrimitive.Close>
          </div>
          <div className="px-5 py-4">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function Tip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <TooltipPrimitive.Root delayDuration={300}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content sideOffset={6} className="z-50 rounded-md bg-text px-2 py-1 text-xs text-bg shadow">{label}</TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

/* ---------------------------------------------------------------- Tabs (simple, accessible) */
export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { value: T; label: string; count?: number }[] }) {
  return (
    <div role="tablist" className="inline-flex rounded-lg border border-border bg-surface p-0.5">
      {items.map((i) => (
        <button key={i.value} role="tab" aria-selected={value === i.value} onClick={() => onChange(i.value)}
          className={cn("rounded-md px-3 py-1.5 text-sm transition-colors", value === i.value ? "bg-surface-2 font-medium text-text" : "text-text-2 hover:text-text")}>
          {i.label}{i.count != null && <span className="ml-1.5 text-xs text-text-3">{i.count}</span>}
        </button>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- Stat tile */
export function Stat({ label, value, hint, icon }: { label: string; value: ReactNode; hint?: ReactNode; icon?: ReactNode }) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between text-sm text-text-2">{label}{icon && <span className="text-text-3">{icon}</span>}</div>
      <div className="mt-2 text-2xl font-semibold tabular-nums tracking-tight">{value}</div>
      {hint && <div className="mt-1 text-xs text-text-3">{hint}</div>}
    </Card>
  );
}

export function Table({ head, children, empty }: { head: ReactNode[]; children: ReactNode; empty?: boolean }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-surface">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-border text-xs uppercase tracking-wide text-text-3">
          <tr>{head.map((h, i) => <th key={i} scope="col" className="px-4 py-2.5 font-medium">{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-border">{children}</tbody>
      </table>
      {empty && <p className="px-4 py-8 text-center text-sm text-text-2">Nothing here yet.</p>}
    </div>
  );
}

export function Code({ children }: { children: ReactNode }) {
  return <pre className="max-h-80 overflow-auto rounded-lg bg-surface-2 p-3 font-mono text-xs leading-relaxed text-text-2">{children}</pre>;
}
