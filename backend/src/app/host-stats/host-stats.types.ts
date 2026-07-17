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
  dockerDisk: { usedBytes: number } | null;
  sampledAt: string;
};

export type HostStatsHistoryPoint = {
  t: string;
  cpuPct: number;
  memPct: number;
  diskPct: number;
  containersRunning: number;
  containersTotal: number;
};
