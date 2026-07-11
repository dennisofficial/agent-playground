"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { env } from "@/lib/env";
import { fetchWithRefresh } from "./refresh";
import { qk } from "./query-keys";
import { subscribeSse } from "./sse-manager";

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

async function fetchHistory(hours: number): Promise<HostStatsHistory> {
  const res = await fetchWithRefresh(`${BASE}/host-stats/history?hours=${hours}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    const err = new Error(res.statusText) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as HostStatsHistory;
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

/**
 * The last `hours` of bucketed host-stats samples (`GET /host-stats/history`), feeding the panel's
 * per-metric sparklines. Polled on a slow 60s cadence — the SSE stream below keeps the live number fresh
 * in between, so the chart only needs to catch up on new buckets, not track every sample.
 */
export function useHostStatsHistory(hours = 24) {
  return useQuery({
    queryKey: qk.hostStatsHistory(hours),
    queryFn: () => fetchHistory(hours),
    staleTime: 60_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
}

/**
 * Live-patches the `host-stats` query cache from the `/host-stats/realtime` SSE stream — each frame is the
 * full snapshot JSON, so this simply overwrites the cache rather than diffing. Unlike the jobs realtime
 * stream, this endpoint never sends a `disabled` control frame, so there's nothing to seal on.
 */
export function useHostStatsRealtime(): void {
  const qc = useQueryClient();

  useEffect(() => {
    const onFrame = (data: string) => {
      try {
        const snap = JSON.parse(data) as HostStats;
        qc.setQueryData(qk.hostStats(), snap);
      } catch {
        // ignore parse errors
      }
    };

    return subscribeSse(`${env.NEXT_PUBLIC_HTTP_URL}/web/host-stats/realtime`, {
      onFrame,
    });
  }, [qc]);
}
