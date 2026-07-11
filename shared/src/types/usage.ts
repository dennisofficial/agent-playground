// Host-side Claude subscription usage — the WIRE CONTRACT for `GET /web/orgs/:orgId/usage`. Windows are
// merged from turn-harvested `rate_limit_event` frames (fresh, free) and the unofficial `/api/oauth/usage`
// HTTP fallback (cold/idle orgs). `ok:false` means both sources are unavailable — the UI shows "unknown"
// rather than a stale/misleading number.

export type UsageWindow = { utilization: number; resetsAt: string } | null;

/**
 * A per-MODEL weekly cap from the usage API's `limits[]` array (a `weekly_scoped` entry, e.g. the "Fable"
 * model), which the flat top-level windows don't carry. `resetsAt` is nullable — a scoped weekly may not
 * report its own reset instant.
 */
export type ModelUsageWindow = { label: string; utilization: number; resetsAt: string | null };

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
  /**
   * Panel-header display label for the org's SELECTED Claude account — the account email, falling back to
   * the credential's label. Absent when no credential is selected (header shows the neutral title).
   */
  accountLabel?: string;
  /** Subscription plan label for the header badge (e.g. "Max plan"). Absent for setup-tokens / unknown plan. */
  plan?: string;
  /**
   * Per-model weekly caps from the usage API `limits[]` (e.g. "Fable") — rendered as extra panel rows.
   * Only from the live usage API (harvest never carries them); empty/absent when none or on a degraded fetch.
   */
  modelWindows?: ModelUsageWindow[];
};

export type StoredUsageWindow = { utilization: number; resetsAt: string };
export type ClaudeUsageWindowKey = 'fiveHour' | 'sevenDay' | 'sevenDayOpus' | 'sevenDaySonnet';
/** Durable per-credential-row usage snapshot (org_credentials.claude_usage_snapshot). fetchedAt = epoch ms. */
export type ClaudeUsageSnapshot = {
  windows: Partial<Record<ClaudeUsageWindowKey, StoredUsageWindow>>;
  fetchedAt: number;
};
