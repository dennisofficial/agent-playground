"use client";

import { useQuery } from "@tanstack/react-query";
import { env } from "@/lib/env";
import { fetchWithRefresh } from "./refresh";
import { qk } from "./query-keys";

/**
 * The host box's live machine-stats snapshot (`GET /web/host-stats`). Login-gated but NOT org-scoped —
 * every authenticated operator sees the same numbers. Mirrors the backend `HostStatsDto`.
 */
export interface HostStats {
  cpu: { usagePct: number; cores: number; loadAvg: [number, number, number] };
  memory: { usedBytes: number; totalBytes: number; usagePct: number };
  disk: { usedBytes: number; totalBytes: number; usagePct: number; path: string };
  host: { uptimeSeconds: number };
  containers: { running: number; total: number };
  /** null when the container engine can't report `docker system df`. */
  dockerDisk: { usedBytes: number } | null;
  /** ISO timestamp of when the snapshot was sampled server-side. */
  sampledAt: string;
}

const BASE = `${env.NEXT_PUBLIC_HTTP_URL}/web`;

async function fetchHostStats(): Promise<HostStats> {
  const res = await fetchWithRefresh(`${BASE}/host-stats`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    const err = new Error(res.statusText) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as HostStats;
}

/**
 * Poll the host-stats snapshot every 5s (matching `useServices`), only while the tab is focused —
 * this is ancillary top-bar chrome, so it must never block or error the shell. React Query keeps the
 * last snapshot on a transient failure; the widget dims rather than throws.
 */
export function useHostStats() {
  return useQuery({
    queryKey: qk.hostStats(),
    queryFn: fetchHostStats,
    staleTime: 4_000,
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
  });
}
