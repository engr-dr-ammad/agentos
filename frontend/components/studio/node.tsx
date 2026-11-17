"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  AlertCircle, Book, Bot, Calculator, Check, Clock, Database, Flag, Globe, Hourglass, Mail, Play, Shield, Shuffle, Split, User, Webhook,
} from "lucide-react";
import { memo } from "react";
import { cn } from "@/lib/utils";
import type { NodeSpec } from "@/lib/types";

export const ICONS: Record<string, typeof Bot> = {
  play: Play, webhook: Webhook, clock: Clock, bot: Bot, split: Split, shuffle: Shuffle, check: Check, book: Book, calculator: Calculator,
  shield: Shield, user: User, mail: Mail, database: Database, globe: Globe, hourglass: Hourglass, flag: Flag,
};

export type StudioNodeData = {
  kind: string; label?: string; config: Record<string, unknown>; spec?: NodeSpec; status?: string; issues?: number; subtitle?: string;
};

const STATUS_RING: Record<string, string> = {
  completed: "border-good", running: "border-accent node-running", retrying: "border-warning node-running", awaiting_approval: "border-warning",
  waiting: "border-text-3", failed: "border-critical", failed_continued: "border-warning", rejected: "border-critical", skipped: "border-border opacity-50",
};

const HANDLE_LABEL: Record<string, string> = { true: "yes", false: "no", ok: "ok", violation: "rule broken", valid: "valid", invalid: "invalid", error: "on error" };

function StudioNode({ data, selected }: NodeProps) {
  const d = data as unknown as StudioNodeData;
  const spec = d.spec;
  const Icon = ICONS[spec?.icon ?? "bot"] ?? Bot;
  const isTrigger = d.kind.startsWith("trigger.");
  const outputs = spec?.outputs ?? ["default"];
  const named = outputs.filter((o) => o !== "default");
  const side = spec?.side_effect;
  return (
    <div className={cn("w-56 rounded-xl border-2 bg-surface shadow-sm transition-colors",
      d.status ? STATUS_RING[d.status] ?? "border-border" : selected ? "border-accent" : "border-border",
      d.issues && !d.status ? "border-critical/60" : "")}>
      {!isTrigger && <Handle type="target" position={Position.Left} aria-label="Input" />}
      <div className="flex items-start gap-2.5 p-3">
        <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-lg", isTrigger ? "bg-good/10 text-good" : d.kind === "agent" ? "bg-accent-soft text-accent"
          : d.kind === "human.approval" ? "bg-warning/10 text-warning" : side ? "bg-serious/10 text-serious" : "bg-surface-2 text-text-2")}>
          <Icon className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11px] uppercase tracking-wide text-text-3">{spec?.label ?? d.kind}</p>
          <p className="truncate text-sm font-medium">{d.label || spec?.label}</p>
          {d.subtitle && <p className="truncate text-xs text-text-2">{d.subtitle}</p>}
        </div>
        {!!d.issues && !d.status && <AlertCircle className="h-4 w-4 shrink-0 text-critical" aria-label={`${d.issues} problem(s)`} />}
      </div>
      {d.status && <div className="border-t border-border px-3 py-1 text-[11px] capitalize text-text-2">{d.status.replace(/_/g, " ")}</div>}
      {outputs.length > 0 && named.length === 0 && <Handle type="source" position={Position.Right} id="default" aria-label="Output" />}
      {outputs.includes("default") && named.length > 0 && <Handle type="source" position={Position.Right} id="default" style={{ top: "35%" }} aria-label="Output" />}
      {named.map((h, i) => {
        const top = outputs.includes("default") ? 60 + i * 18 : ((i + 1) / (named.length + 1)) * 100;
        return (
          <div key={h}>
            <Handle type="source" position={Position.Right} id={h} style={{ top: `${top}%`, background: h === "error" || h === "false" || h === "violation" || h === "invalid" ? "var(--serious)" : undefined }} aria-label={HANDLE_LABEL[h] ?? h} />
            <span className="pointer-events-none absolute -right-1 translate-x-full text-[10px] text-text-3" style={{ top: `calc(${top}% - 7px)` }}>{HANDLE_LABEL[h] ?? h}</span>
          </div>
        );
      })}
    </div>
  );
}

export default memo(StudioNode);
