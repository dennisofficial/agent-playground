// Per-ACCOUNT subscription usage — how close one agent account is to its 5-hour / weekly wall. Each
// `agent_credentials` row carries its own snapshot (no org-level sharing → no "trust the selected
// account" gymnastics). Windows are merged from two sources: turn-harvested `rate_limit_event` frames
// (fresh, free — arrives once the engine runs turns) and the direct `/api/oauth/usage` HTTP poll
// (Claude only). `ok:false` means no source was available — the UI shows "unknown" rather than a
// stale number.

/** A single rolling window: percent used + when it resets. `null` when the source didn't report it. */
export type UsageWindow = { utilization: number; resetsAt: string } | null;

/**
 * A per-MODEL weekly cap from the usage API's `limits[]` array (a `weekly_scoped` entry, e.g. the
 * "Fable" model), which the flat top-level windows don't carry. `resetsAt` is nullable — a scoped
 * weekly may not report its own reset instant.
 */
export type ModelUsageWindow = { label: string; utilization: number; resetsAt: string | null };

/** The four flat Claude subscription windows. */
export type ClaudeUsageWindowKey = 'fiveHour' | 'sevenDay' | 'sevenDayOpus' | 'sevenDaySonnet';

/** A non-null stored window (utilization + reset instant) — the shape persisted in a snapshot. */
export type StoredUsageWindow = { utilization: number; resetsAt: string };

/**
 * Durable per-account usage snapshot persisted in `agent_credentials.usage_snapshot` (jsonb). Scoped to
 * one account, so no `credentialId` trust tag is needed. `fetchedAt` is epoch ms — the freshness key
 * used when merging a new window (freshest wins per window). `source` records where it last came from.
 */
export type AccountUsageSnapshot = {
  windows: Partial<Record<ClaudeUsageWindowKey, StoredUsageWindow>>;
  /** Per-model weekly caps (Claude usage API only; harvest never carries them). */
  modelWindows?: ModelUsageWindow[];
  fetchedAt: number;
  source: 'harvested' | 'usage_api';
};

/**
 * Wire projection of an account's usage — assembled from its {@link AccountUsageSnapshot} for the
 * `AgentCredentialView`. `ok:false` (source `stale`) => degraded, UI shows "unknown" instead of windows.
 */
export type AccountUsage = {
  fiveHour: UsageWindow;
  sevenDay: UsageWindow;
  sevenDayOpus: UsageWindow;
  sevenDaySonnet: UsageWindow;
  /** Per-model weekly caps (e.g. "Fable") — rendered as extra rows; empty when none. */
  modelWindows: ModelUsageWindow[];
  /** ISO timestamp the snapshot was assembled. */
  fetchedAt: string;
  /** Where the windows came from: turn-harvested, the live usage API, or a stale/absent snapshot. */
  source: 'harvested' | 'usage_api' | 'stale';
  /** false => no source available → UI shows "unknown". */
  ok: boolean;
};

// Legacy org-level usage (pre-per-account model). Still consumed by old web code (usage-ring,
// lib/api/types) during the rebuild. Superseded by the per-account AccountUsage above; kept
// additively so unrelated old code keeps compiling.

export type OrgUsage = {
  fiveHour: UsageWindow;
  sevenDay: UsageWindow;
  sevenDayOpus: UsageWindow;
  sevenDaySonnet: UsageWindow;
  fetchedAt: string;
  source: 'harvested' | 'usage_api' | 'stale';
  ok: boolean;
  accountLabel?: string;
  plan?: string;
  modelWindows?: ModelUsageWindow[];
};

/** Legacy durable snapshot (org_credentials.claude_usage_snapshot). fetchedAt = epoch ms. */
export type ClaudeUsageSnapshot = {
  windows: Partial<Record<ClaudeUsageWindowKey, StoredUsageWindow>>;
  fetchedAt: number;
  credentialId?: string;
};
