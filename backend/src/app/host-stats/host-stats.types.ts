/** The `GET /web/host-stats` response — a live snapshot of the host box. */
export type HostStatsDto = {
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
  /** null if the engine can't report df */
  dockerDisk: { usedBytes: number } | null;
  /** ISO */
  sampledAt: string;
};
