"use client";

import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { toast } from "sonner";
import { get } from "./api";
import type { Role } from "./utils";

export type Me = {
  user: { id: string; email: string; name: string; mfa_enabled: boolean; is_platform_admin: boolean };
  org: { id: string; name: string; role: Role; plan: string; onboarded: boolean; industry: string | null } | null;
  orgs: { id: string; name: string; role: Role; plan: string }[];
};

export const useMe = () => useQuery({ queryKey: ["me"], queryFn: () => get<Me>("/auth/me"), staleTime: 60_000 });

export function useList<T>(key: QueryKey, path: string, opts: { refetchInterval?: number | false; enabled?: boolean } = {}) {
  return useQuery({ queryKey: key, queryFn: () => get<T>(path), ...opts });
}

/** Mutation with toast feedback and cache invalidation. */
export function useAction<TVars, TRes = unknown>(fn: (v: TVars) => Promise<TRes>, opts: {
  success?: string | ((r: TRes) => string); invalidate?: QueryKey[]; onSuccess?: (r: TRes, v: TVars) => void; silentError?: boolean;
} = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r, v) => {
      if (opts.success) toast.success(typeof opts.success === "function" ? opts.success(r) : opts.success);
      opts.invalidate?.forEach((k) => qc.invalidateQueries({ queryKey: k }));
      opts.onSuccess?.(r, v);
    },
    onError: (e: Error) => { if (!opts.silentError) toast.error(e.message); },
  });
}
