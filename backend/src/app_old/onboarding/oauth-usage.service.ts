import { Injectable, Logger } from '@nestjs/common';
import type {
  ClaudeUsageWindowKey,
  ModelUsageWindow,
  OrgUsage,
  StoredUsageWindow,
  UsageWindow,
} from '@workspace/shared';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resetEpochToIso } from '../../_shared/engine/session-limit';
import { ClaudeCredentialStore } from './claude-credential.store';
import { CredentialRefreshService } from './credential-refresh.service';
import { CredentialResolver } from './credential-resolver.service';
import { TenantCredentialStore } from './tenant-credential.store';
import { UsageEventBus } from './usage-event-bus';

type WindowKey = ClaudeUsageWindowKey;

const RATE_LIMIT_TYPE_TO_WINDOW: Record<string, WindowKey> = {
  five_hour: 'fiveHour',
  seven_day: 'sevenDay',
  seven_day_opus: 'sevenDayOpus',
  seven_day_sonnet: 'sevenDaySonnet',
};

const EMPTY_WINDOWS: Record<WindowKey, UsageWindow> = {
  fiveHour: null,
  sevenDay: null,
  sevenDayOpus: null,
  sevenDaySonnet: null,
};

const LIVE_FLOOR_MS = 60 * 1000;

const FETCH_TIMEOUT_MS = 10_000;

const FALLBACK_CLAUDE_CODE_VERSION = '2.1.204';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

type LiveCacheEntry = {
  usage: OrgUsage;
  fetchedAtMs: number;
};

@Injectable()
export class OauthUsageService {
  private readonly logger = new Logger(OauthUsageService.name);
  private readonly claudeCodeVersion = resolveClaudeCodeVersion();

  private readonly liveCache = new Map<string, LiveCacheEntry>();
  private readonly credentialLiveCache = new Map<string, LiveCacheEntry>();

  constructor(
    private readonly credentials: CredentialResolver,
    private readonly store: TenantCredentialStore,
    private readonly claudeStore: ClaudeCredentialStore,
    private readonly bus: UsageEventBus,
    private readonly credRefresh: CredentialRefreshService,
  ) {}

  async applyHarvest(
    orgId: string,
    info: {
      status?: string;
      resetsAt?: number;
      rateLimitType?: string;
      utilization?: number;
      credentialId?: string;
    },
  ): Promise<void> {
    try {
      const resetsAt = resetEpochToIso(info.resetsAt);
      if (!resetsAt) return;
      const rejected = info.status === 'rejected';
      const utilization = rejected ? 100 : toPercentUtilization(info.utilization);
      if (utilization == null) return;
      const rateLimitType = info.rateLimitType ?? (rejected ? 'five_hour' : undefined);
      if (!rateLimitType) return;
      const key = RATE_LIMIT_TYPE_TO_WINDOW[rateLimitType];
      if (!key) return;
      const changed = await this.store.mergeClaudeUsageWindow(
        orgId,
        key,
        { utilization, resetsAt },
        Date.now(),
        info.credentialId,
      );
      if (changed) void this.publishHarvested(orgId);
    } catch (err) {
      this.logger.warn(`applyHarvest failed org=${orgId}: ${errorText(err)}`);
    }
  }

  async fetchLive(orgId: string): Promise<OrgUsage> {
    try {
      const auth = await this.credentials.engineAuth(orgId, 'claude');
      if (!auth) return degradedUsage();
      let secret = auth.secret;
      if (auth.kind === 'personal' && auth.refreshBack?.credentialId) {
        try {
          secret = await this.credRefresh.ensureFresh(orgId, auth.refreshBack.credentialId);
        } catch (err) {
          this.logger.warn(`usage refresh failed org=${orgId}: ${errorText(err)}`);
          return degradedUsage();
        }
      }
      const accessToken = bearerTokenFromSecret(secret, auth.kind);
      if (!accessToken) return degradedUsage();
      return await this.fetchUsageWithToken(accessToken);
    } catch (err) {
      this.logger.warn(`usage fetch failed org=${orgId}: ${errorText(err)}`);
      return degradedUsage();
    }
  }

  private async fetchUsageWithToken(accessToken: string): Promise<OrgUsage> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'User-Agent': `claude-code/${this.claudeCodeVersion}`,
          'content-type': 'application/json',
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        this.logger.warn(`usage fetch failed: HTTP ${res.status}`);
        return degradedUsage();
      }
      const body: unknown = await res.json();
      return parseUsageResponse(body);
    } finally {
      clearTimeout(timeout);
    }
  }

  async getForCredential(orgId: string, credentialId: string): Promise<OrgUsage> {
    const row = (await this.claudeStore.list(orgId)).find((r) => r.id === credentialId);
    if (!row || row.kind !== 'personal') return degradedUsage();
    return this.liveCredentialSnapshot(orgId, credentialId);
  }

  async get(orgId: string): Promise<OrgUsage> {
    const snapshot = await this.store.readClaudeUsageSnapshot(orgId);
    const selectedId = await this.claudeStore.getSelectedCredentialId(orgId);
    const harvestTrusted = !!snapshot?.credentialId && snapshot.credentialId === selectedId;
    const now = Date.now();
    const harvestWindows: Partial<Record<ClaudeUsageWindowKey, StoredUsageWindow>> = {};
    if (harvestTrusted) {
      for (const [key, w] of Object.entries(snapshot?.windows ?? {})) {
        if (w && new Date(w.resetsAt).getTime() > now)
          harvestWindows[key as ClaudeUsageWindowKey] = w;
      }
    }
    const harvestIsEmpty = Object.keys(harvestWindows).length === 0;

    const live = await this.liveSnapshot(orgId);

    const hasHarvest = !harvestIsEmpty;
    const hasLive = live.ok;
    const harvestAtMs = snapshot?.fetchedAt;
    const liveAtMs = new Date(live.fetchedAt).getTime();
    const harvestWins = hasHarvest && (!hasLive || (harvestAtMs ?? 0) >= liveAtMs);
    const liveWins = !harvestWins && hasLive;

    const pick = (key: ClaudeUsageWindowKey): UsageWindow =>
      harvestWins
        ? (harvestWindows[key] ?? live[key] ?? null)
        : (live[key] ?? harvestWindows[key] ?? null);

    const fetchedAt = harvestWins
      ? new Date(harvestAtMs ?? now).toISOString()
      : liveWins
        ? live.fetchedAt
        : new Date().toISOString();

    const merged: OrgUsage = {
      fiveHour: pick('fiveHour'),
      sevenDay: pick('sevenDay'),
      sevenDayOpus: pick('sevenDayOpus'),
      sevenDaySonnet: pick('sevenDaySonnet'),
      modelWindows: live.modelWindows ?? [],
      fetchedAt,
      source: harvestWins ? 'harvested' : liveWins ? 'usage_api' : 'stale',
      ok: harvestWins || liveWins,
    };
    return this.withAccount(orgId, merged);
  }

  async invalidate(orgId: string): Promise<void> {
    this.liveCache.delete(orgId);
    await this.store.clearClaudeUsageSnapshot(orgId);
    void this.get(orgId)
      .then((usage) => this.bus.publish({ orgId, usage }))
      .catch(() => {});
  }

  async getResetAt(orgId: string, rateLimitType?: string): Promise<string | undefined> {
    const snapshot = await this.store.readClaudeUsageSnapshot(orgId);
    if (!snapshot) return undefined;
    const key = (rateLimitType && RATE_LIMIT_TYPE_TO_WINDOW[rateLimitType]) || 'fiveHour';
    return snapshot.windows[key]?.resetsAt;
  }

  async getUtilization(orgId: string, rateLimitType?: string): Promise<number | undefined> {
    const snapshot = await this.store.readClaudeUsageSnapshot(orgId);
    if (!snapshot) return undefined;
    const key = (rateLimitType && RATE_LIMIT_TYPE_TO_WINDOW[rateLimitType]) || 'fiveHour';
    const w = snapshot.windows[key];
    const resetAtMs = w ? new Date(w.resetsAt).getTime() : NaN;
    if (!w || !Number.isFinite(resetAtMs) || resetAtMs <= Date.now()) return undefined;
    return w.utilization;
  }

  private async liveSnapshot(orgId: string): Promise<OrgUsage> {
    const cached = this.liveCache.get(orgId);
    if (cached && Date.now() - cached.fetchedAtMs < LIVE_FLOOR_MS) return cached.usage;
    const usage = await this.fetchLive(orgId);
    this.liveCache.set(orgId, { usage, fetchedAtMs: Date.now() });
    return usage;
  }

  private async publishHarvested(orgId: string): Promise<void> {
    try {
      this.bus.publish({ orgId, usage: await this.get(orgId) });
    } catch (err) {
      this.logger.warn(`publishHarvested failed org=${orgId}: ${errorText(err)}`);
    }
  }

  private async withAccount(orgId: string, usage: OrgUsage): Promise<OrgUsage> {
    try {
      const display = await this.claudeStore.getSelectedDisplay(orgId);
      if (!display) return usage;
      return {
        ...usage,
        accountLabel: display.accountEmail ?? display.label,
        plan: planLabel(display.subscriptionType),
      };
    } catch (err) {
      this.logger.warn(`withAccount failed org=${orgId}: ${errorText(err)}`);
      return usage;
    }
  }

  private async liveCredentialSnapshot(orgId: string, credentialId: string): Promise<OrgUsage> {
    const cached = this.credentialLiveCache.get(credentialId);
    if (cached && Date.now() - cached.fetchedAtMs < LIVE_FLOOR_MS) return cached.usage;
    const usage = await this.fetchLiveForCredential(orgId, credentialId);
    this.credentialLiveCache.set(credentialId, {
      usage,
      fetchedAtMs: Date.now(),
    });
    return usage;
  }

  private async fetchLiveForCredential(orgId: string, credentialId: string): Promise<OrgUsage> {
    let secret: string;
    try {
      secret = await this.credRefresh.ensureFresh(orgId, credentialId);
    } catch (err) {
      this.logger.warn(`cred usage refresh failed ${credentialId}: ${errorText(err)}`);
      return degradedUsage();
    }
    try {
      const accessToken = bearerTokenFromSecret(secret, 'personal');
      if (!accessToken) return degradedUsage();
      return await this.fetchUsageWithToken(accessToken);
    } catch (err) {
      this.logger.warn(`cred usage fetch failed ${credentialId}: ${errorText(err)}`);
      return degradedUsage();
    }
  }
}

function planLabel(subscriptionType: string | null | undefined): string | undefined {
  const t = subscriptionType?.trim();
  if (!t) return undefined;
  const titled = t.charAt(0).toUpperCase() + t.slice(1);
  return /plan/i.test(t) ? titled : `${titled} plan`;
}

export function toPercentUtilization(utilization: number | undefined): number | undefined {
  if (utilization == null) return undefined;
  const percent = utilization <= 1 ? utilization * 100 : utilization;
  return Math.round(Math.min(100, Math.max(0, percent)));
}

function degradedUsage(): OrgUsage {
  return {
    ...EMPTY_WINDOWS,
    fetchedAt: new Date().toISOString(),
    source: 'stale',
    ok: false,
    modelWindows: [],
  };
}

export function parseModelWindows(root: Record<string, unknown>): ModelUsageWindow[] {
  const limits = root.limits;
  if (!Array.isArray(limits)) return [];
  const out: ModelUsageWindow[] = [];
  for (const raw of limits) {
    if (!raw || typeof raw !== 'object') continue;
    const l = raw as {
      kind?: unknown;
      percent?: unknown;
      resets_at?: unknown;
      scope?: unknown;
    };
    if (l.kind !== 'weekly_scoped') continue;
    const label = (l.scope as { model?: { display_name?: unknown } } | undefined)?.model
      ?.display_name;
    if (typeof label !== 'string' || label.length === 0) continue;
    if (typeof l.percent !== 'number') continue;
    out.push({
      label,
      utilization: Math.round(Math.min(100, Math.max(0, l.percent))),
      resetsAt: typeof l.resets_at === 'string' ? l.resets_at : null,
    });
  }
  return out;
}

function bearerTokenFromSecret(
  secret: string,
  kind: 'setup-token' | 'personal' | undefined,
): string | null {
  if (kind !== 'personal') return secret;
  try {
    const t = (JSON.parse(secret) as { claudeAiOauth?: { accessToken?: unknown } }).claudeAiOauth
      ?.accessToken;
    return typeof t === 'string' && t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

function parseWindow(raw: unknown): UsageWindow {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as { utilization?: unknown; resets_at?: unknown };
  const utilization = typeof w.utilization === 'number' ? w.utilization : null;
  if (utilization == null) return null;
  const resetsAtMs =
    typeof w.resets_at === 'string' || typeof w.resets_at === 'number'
      ? new Date(w.resets_at).getTime()
      : NaN;
  if (Number.isNaN(resetsAtMs)) return null;
  return {
    utilization: Math.round(Math.min(100, Math.max(0, utilization))),
    resetsAt: new Date(resetsAtMs).toISOString(),
  };
}

function parseUsageResponse(body: unknown): OrgUsage {
  const root = (body ?? {}) as Record<string, unknown>;
  const nested =
    (root.windows as Record<string, unknown> | undefined) ??
    (root.rate_limits as Record<string, unknown> | undefined) ??
    {};
  const pick = (key: string): unknown => root[key] ?? nested[key];
  const windows = {
    fiveHour: parseWindow(pick('five_hour')),
    sevenDay: parseWindow(pick('seven_day')),
    sevenDayOpus: parseWindow(pick('seven_day_opus')),
    sevenDaySonnet: parseWindow(pick('seven_day_sonnet')),
  };
  const modelWindows = parseModelWindows(root);
  return {
    ...windows,
    fetchedAt: new Date().toISOString(),
    source: 'usage_api',
    ok: true,
    modelWindows,
  };
}

function resolveClaudeCodeVersion(): string {
  try {
    const pkgPath = join(
      __dirname,
      '..',
      '..',
      '..',
      'node_modules',
      '@anthropic-ai',
      'claude-agent-sdk',
      'package.json',
    );
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      claudeCodeVersion?: string;
      version?: string;
    };
    return pkg.claudeCodeVersion ?? pkg.version ?? FALLBACK_CLAUDE_CODE_VERSION;
  } catch {
    return FALLBACK_CLAUDE_CODE_VERSION;
  }
}
