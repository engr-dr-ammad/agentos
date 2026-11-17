"use client";

import { Globe } from "lucide-react";
import { BROWSER_EDITION } from "@/lib/env";

/** Visible label so the static GitHub Pages build is never mistaken for the multi-user server edition. */
export function EditionBadge({ compact = false }: { compact?: boolean }) {
  if (!BROWSER_EDITION) return null;
  return (
    <span title="Browser edition: runs entirely in this browser. Your data and API keys are stored in this browser only."
      className="inline-flex items-center gap-1 rounded-md border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[11px] font-medium text-warning">
      <Globe className="h-3 w-3" aria-hidden />{compact ? "Browser" : "Browser edition"}
    </span>
  );
}

export function EditionNotice() {
  if (!BROWSER_EDITION) return null;
  return (
    <div className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-text-2">
      <b className="text-text">Browser edition.</b> Everything runs and is stored in this browser (single user). API keys you add are kept in this
      browser and sent only to the AI provider you choose. Emails go to the sandbox outbox; schedules run while this tab is open.
    </div>
  );
}
