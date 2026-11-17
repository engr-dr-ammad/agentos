import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export const cn = (...v: ClassValue[]) => twMerge(clsx(v));

export function money(v: number | null | undefined, digits = 2) {
  if (v == null) return "—";
  if (v > 0 && v < 0.01) return `$${v.toFixed(4)}`;
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: digits }).format(v);
}

export function ago(iso?: string | null) {
  if (!iso) return "—";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export const dt = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";

export function pct(v: number | null | undefined) {
  return v == null ? "—" : `${Math.round(v * 100)}%`;
}

export const ROLE_RANK = { viewer: 0, employee: 1, manager: 2, admin: 3, owner: 4 } as const;
export type Role = keyof typeof ROLE_RANK;
export const can = (role: Role | undefined, need: Role) => !!role && ROLE_RANK[role] >= ROLE_RANK[need];
