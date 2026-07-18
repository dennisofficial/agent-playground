import {
  type AccountUsage,
  type AccountUsageSnapshot,
  type AgentCredentialView,
  type ClaudeUsageWindowKey,
  type EAgentCredentialKind,
  type EAgentCredentialStatus,
  type EAgentProvider,
  type UsageWindow,
} from '@workspace/shared';

/** The already-camel-cased fields needed to build a view — shared by the service and the realtime mapRow. */
export type AgentCredentialViewInput = {
  id: string;
  provider: EAgentProvider;
  kind: EAgentCredentialKind;
  label: string;
  accountEmail: string | null;
  subscriptionType: string | null;
  status: EAgentCredentialStatus;
  selected: boolean;
  expiresAt: Date | string | null;
  usageSnapshot: AccountUsageSnapshot | null;
  createdAt: Date | string;
};

const iso = (d: Date | string | null): string | null =>
  d == null ? null : d instanceof Date ? d.toISOString() : d;

/** Project a credential (entity or WAL row) to its wire view. Never touches token material. */
export function projectAgentCredentialView(input: AgentCredentialViewInput): AgentCredentialView {
  return {
    id: input.id,
    provider: input.provider,
    kind: input.kind,
    label: input.label,
    accountEmail: input.accountEmail,
    plan: planLabel(input.subscriptionType),
    status: input.status,
    selected: input.selected,
    expiresAt: iso(input.expiresAt),
    usage: snapshotToUsage(input.usageSnapshot),
    createdAt: iso(input.createdAt) ?? new Date(0).toISOString(),
  };
}

export function planLabel(subscriptionType: string | null): string | null {
  const t = subscriptionType?.trim();
  if (!t) return null;
  const titled = t.charAt(0).toUpperCase() + t.slice(1);
  return /plan/i.test(t) ? titled : `${titled} plan`;
}

/** Project the stored per-account snapshot to the wire view; windows past their reset are dropped. */
export function snapshotToUsage(snap: AccountUsageSnapshot | null): AccountUsage | null {
  if (!snap) return null;
  const now = Date.now();
  const live = (key: ClaudeUsageWindowKey): UsageWindow => {
    const w = snap.windows[key];
    if (!w) return null;
    return new Date(w.resetsAt).getTime() > now
      ? { utilization: w.utilization, resetsAt: w.resetsAt }
      : null;
  };
  const windows = {
    fiveHour: live('fiveHour'),
    sevenDay: live('sevenDay'),
    sevenDayOpus: live('sevenDayOpus'),
    sevenDaySonnet: live('sevenDaySonnet'),
  };
  const modelWindows = snap.modelWindows ?? [];
  const ok = Object.values(windows).some(Boolean) || modelWindows.length > 0;
  return {
    ...windows,
    modelWindows,
    fetchedAt: new Date(snap.fetchedAt).toISOString(),
    source: ok ? snap.source : 'stale',
    ok,
  };
}
