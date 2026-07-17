"use client";

import { stubQuery, type QueryResultLike } from "./_stub";

/**
 * The host box's live machine-stats snapshot (`GET /web/host-stats`). Login-gated but NOT org-scoped —
 * every authenticated operator sees the same numbers. Mirrors the backend `HostStatsDto`.
 */
export type HostStats = {
  cpu: { usagePct: number; cores: number; loadAvg: [number, number, number] };
  memory: { usedBytes: number; totalBytes: number; usagePct: number };
  disk: {
    usedBytes: number;
    totalBytes: number;
    usagePct: number;
    path: string;
  };
  host: { uptimeSeconds: number };
  containers: { running: number; total: number };
  /** null when the container engine can't report `docker system df`. */
  dockerDisk: { usedBytes: number } | null;
  /** ISO timestamp of when the snapshot was sampled server-side. */
  sampledAt: string;
};

/** One bucketed sample of the `/host-stats/history` series. Mirrors the backend `HostStatsHistoryPoint`. */
export type HostStatsHistoryPoint = {
  /** ISO bucket start. */
  t: string;
  cpuPct: number;
  memPct: number;
  diskPct: number;
  containersRunning: number;
  containersTotal: number;
};

export type HostStatsHistory = { points: HostStatsHistoryPoint[] };

// TODO(rtk): backend host-stats endpoints not wired yet — widgets render their empty state.
export function useHostStats(): QueryResultLike<HostStats> {
  return stubQuery<HostStats>();
}

export function useHostStatsHistory(_hours = 24): QueryResultLike<HostStatsHistory> {
  return stubQuery<HostStatsHistory>();
}

/** No-op until the `/web/host-stats/realtime` SSE endpoint exists. */
export function useHostStatsRealtime(): void {}
