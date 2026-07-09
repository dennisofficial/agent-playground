// Host-side Claude subscription usage — the WIRE CONTRACT for `GET /web/orgs/:orgId/usage`. Windows are
// merged from turn-harvested `rate_limit_event` frames (fresh, free) and the unofficial `/api/oauth/usage`
// HTTP fallback (cold/idle orgs). `ok:false` means both sources are unavailable — the UI shows "unknown"
// rather than a stale/misleading number.

export type UsageWindow = { utilization: number; resetsAt: string } | null;

export type OrgUsage = {
  fiveHour: UsageWindow;
  sevenDay: UsageWindow;
  sevenDayOpus: UsageWindow;
  sevenDaySonnet: UsageWindow;
  /** ISO timestamp the snapshot was assembled. */
  fetchedAt: string;
  /** Where the merged snapshot came from: turn-harvested, the live usage API, or a stale cached copy. */
  source: 'harvested' | 'usage_api' | 'stale';
  /** false => degraded (both sources unavailable) → UI shows "unknown" instead of the windows. */
  ok: boolean;
};
