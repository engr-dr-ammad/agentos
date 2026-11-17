export class ApiError extends Error {
  constructor(public status: number, message: string, public data?: unknown) {
    super(message);
  }
}

function messageFrom(data: unknown, status: number): string {
  if (data && typeof data === "object" && "detail" in data) {
    const d = (data as { detail: unknown }).detail;
    if (typeof d === "string") return d;
    if (d && typeof d === "object" && "message" in d) return String((d as { message: unknown }).message);
  }
  return status >= 500 ? "Something went wrong on our side. Please try again." : `Request failed (${status})`;
}

export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  const res = await fetch(`/api/v1${path}`, {
    credentials: "same-origin",
    ...rest,
    headers: {
      "x-agentos-csrf": "1",
      ...(json !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const text = await res.text();
  const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (!res.ok) {
    if (res.status === 401 && typeof window !== "undefined" && window.location.pathname.startsWith("/app")) {
      window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
    }
    throw new ApiError(res.status, messageFrom(data, res.status), data);
  }
  return data as T;
}

export const get = <T,>(p: string) => api<T>(p);
export const post = <T,>(p: string, json?: unknown) => api<T>(p, { method: "POST", json: json ?? {} });
export const patch = <T,>(p: string, json: unknown) => api<T>(p, { method: "PATCH", json });
export const del = <T,>(p: string) => api<T>(p, { method: "DELETE" });

export type Issue = { node_id: string | null; severity: "error" | "warning" | "info"; message: string };

export function issuesFrom(e: unknown): Issue[] {
  if (e instanceof ApiError && e.data && typeof e.data === "object") {
    const d = (e.data as { detail?: { issues?: Issue[] } }).detail;
    if (d && typeof d === "object" && Array.isArray(d.issues)) return d.issues;
  }
  return [];
}
