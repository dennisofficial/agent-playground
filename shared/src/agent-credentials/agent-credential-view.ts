import type { AgentCredentialView } from '../dto/agent-credentials.dto';
import { EAgentCredentialKind, EAgentCredentialStatus, EAgentProvider } from '../enums';
import type {
  AccountUsage,
  AccountUsageSnapshot,
  ClaudeUsageWindowKey,
  UsageWindow,
} from '../types/usage';

/** A raw `agent_credentials` row (camelCase columns), as delivered by REST or the realtime socket. */
export interface RawAgentCredential {
  id: string;
  orgId?: string;
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
}

/** Subscription plan label for the header badge (e.g. "Max plan"); null when unknown / setup-token. */
export function planLabel(subscriptionType: string | null): string | null {
  const t = subscriptionType?.trim();
  if (!t) return null;
  const titled = t.charAt(0).toUpperCase() + t.slice(1);
  return /plan/i.test(t) ? titled : `${titled} plan`;
}

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

function iso(d: Date | string | null): string | null {
  return d == null ? null : d instanceof Date ? d.toISOString() : d;
}

/** Turns a raw `agent_credentials` row into the `AgentCredentialView` wire DTO. */
export function buildAgentCredentialView(raw: RawAgentCredential): AgentCredentialView {
  return {
    id: raw.id,
    provider: raw.provider,
    kind: raw.kind,
    label: raw.label,
    accountEmail: raw.accountEmail,
    plan: planLabel(raw.subscriptionType),
    status: raw.status,
    selected: raw.selected,
    expiresAt: iso(raw.expiresAt),
    usage: snapshotToUsage(raw.usageSnapshot),
    createdAt: iso(raw.createdAt) ?? new Date(0).toISOString(),
  };
}
