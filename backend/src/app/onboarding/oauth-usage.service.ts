import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import type { OrgUsage, UsageWindow } from '@workspace/shared';
import { CredentialResolver } from './credential-resolver.service';

/** The four subscription rate-limit windows the SDK/API report, in `OrgUsage`'s field names. */
type WindowKey = 'fiveHour' | 'sevenDay' | 'sevenDayOpus' | 'sevenDaySonnet';

/** SDK/API `rateLimitType` string → the `OrgUsage` field it fills. */
const RATE_LIMIT_TYPE_TO_WINDOW: Record<string, WindowKey> = {
  five_hour: 'fiveHour',
  seven_day: 'sevenDay',
  seven_day_opus: 'sevenDayOpus',
  seven_day_sonnet: 'sevenDaySonnet',
};

/** Every window merged/parsed empty — the shared "nothing known yet" shape. */
const EMPTY_WINDOWS: Record<WindowKey, UsageWindow> = {
  fiveHour: null,
  sevenDay: null,
  sevenDayOpus: null,
  sevenDaySonnet: null,
};

/** How long a harvested snapshot (or a cached HTTP fallback) is trusted before `get()` re-hits the API. */
const LIVE_FLOOR_MS = 3 * 60 * 1000;

/** Bound the unofficial HTTP call the same way `McpProbeService` bounds its handshake. */
const FETCH_TIMEOUT_MS = 10_000;

const FALLBACK_CLAUDE_CODE_VERSION = '2.1.204';

/** Per-org snapshot of windows harvested from live turns (`applyHarvest`), plus when it was last touched. */
type HarvestSnapshot = {
  windows: Partial<Record<WindowKey, NonNullable<UsageWindow>>>;
  fetchedAt: number;
};

type LiveCacheEntry = {
  usage: OrgUsage;
  fetchedAtMs: number;
};

/**
 * Host-side snapshot of an org's Claude subscription usage — the backing service for
 * `GET /web/orgs/:orgId/usage`.
 *
 * TWO sources, layered:
 *  - PRIMARY (`applyHarvest`): every turn's SDK `rate_limit_event` frames update the org's windows for
 *    FREE, no HTTP call, as a side effect of normal engine activity ({@link TurnHarnessFactory}).
 *  - FALLBACK (`fetchLive`): the unofficial `/api/oauth/usage` HTTP endpoint, used only to fill windows
 *    the harvest hasn't seen yet (a cold/idle org, or the usage popover opened before any turn ran).
 *    Best-effort and non-critical — the endpoint is undocumented and can change shape or disappear; any
 *    failure degrades to `ok:false` ("unknown" in the UI) rather than throwing into a caller.
 */
@Injectable()
export class OauthUsageService {
  private readonly logger = new Logger(OauthUsageService.name);
  private readonly claudeCodeVersion = resolveClaudeCodeVersion();

  private readonly harvested = new Map<string, HarvestSnapshot>();
  private readonly liveCache = new Map<string, LiveCacheEntry>();

  constructor(private readonly credentials: CredentialResolver) {}

  /**
   * PRIMARY. Fold one SDK `rate_limit_event` frame (or the engine's `kind:'rate_limit'` mirror of it)
   * into the org's snapshot. Ignores frames that don't carry a recognized window + both fields — never
   * throws, since this rides the hot turn-event path.
   */
  applyHarvest(
    orgId: string,
    info: { status?: string; resetsAt?: number; rateLimitType?: string; utilization?: number },
  ): void {
    try {
      if (info.resetsAt == null) return;
      // A `rejected` frame IS the hard limit — the window is full by definition, so paint it 100% even
      // when the frame omits `utilization`, and default an unlabeled rejection to the session window (the
      // binding day-to-day one). Non-rejected frames still require a real `utilization` to record.
      const rejected = info.status === 'rejected';
      const utilization = rejected ? 100 : info.utilization;
      if (utilization == null) return;
      const rateLimitType = info.rateLimitType ?? (rejected ? 'five_hour' : undefined);
      if (!rateLimitType) return;
      const key = RATE_LIMIT_TYPE_TO_WINDOW[rateLimitType];
      if (!key) return;
      const snapshot = this.harvested.get(orgId) ?? { windows: {}, fetchedAt: 0 };
      snapshot.windows[key] = {
        utilization,
        resetsAt: new Date(info.resetsAt).toISOString(),
      };
      snapshot.fetchedAt = Date.now();
      this.harvested.set(orgId, snapshot);
    } catch (err) {
      this.logger.warn(`applyHarvest failed org=${orgId}: ${err}`);
    }
  }

  /**
   * COLD/FALLBACK. Hits the unofficial `/api/oauth/usage` endpoint with the org's Claude OAuth secret.
   * Never throws — any failure (no credential, non-200, timeout, unparsable body) returns a degraded
   * `{ ok:false, source:'stale' }` snapshot.
   */
  async fetchLive(orgId: string): Promise<OrgUsage> {
    try {
      const auth = await this.credentials.engineAuth(orgId, 'claude');
      if (!auth) return degradedUsage();

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
          headers: {
            Authorization: `Bearer ${auth.secret}`,
            'anthropic-beta': 'oauth-2025-04-20',
            'User-Agent': `claude-code/${this.claudeCodeVersion}`,
            'Content-Type': 'application/json',
          },
          signal: controller.signal,
        });
        if (!res.ok) {
          this.logger.warn(`usage fetch failed org=${orgId}: HTTP ${res.status}`);
          return degradedUsage();
        }
        const body: unknown = await res.json();
        return parseUsageResponse(body);
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      this.logger.warn(`usage fetch failed org=${orgId}: ${err}`);
      return degradedUsage();
    }
  }

  /**
   * The merged snapshot `GET /web/orgs/:orgId/usage` serves: harvested windows take precedence (fresh,
   * free); the HTTP fallback only fills windows the harvest hasn't populated, and is re-hit at most once
   * per {@link LIVE_FLOOR_MS}. Always resolves to a well-formed `OrgUsage` — `ok:false` when nothing is
   * known from either source.
   */
  async get(orgId: string): Promise<OrgUsage> {
    const snapshot = this.harvested.get(orgId);
    const harvestWindows = snapshot?.windows ?? {};
    const harvestIsEmpty = Object.keys(harvestWindows).length === 0;
    const harvestIsStale = !snapshot || Date.now() - snapshot.fetchedAt >= LIVE_FLOOR_MS;

    const live = harvestIsEmpty || harvestIsStale ? await this.liveSnapshot(orgId) : undefined;

    const merged: OrgUsage = {
      fiveHour: harvestWindows.fiveHour ?? live?.fiveHour ?? null,
      sevenDay: harvestWindows.sevenDay ?? live?.sevenDay ?? null,
      sevenDayOpus: harvestWindows.sevenDayOpus ?? live?.sevenDayOpus ?? null,
      sevenDaySonnet: harvestWindows.sevenDaySonnet ?? live?.sevenDaySonnet ?? null,
      fetchedAt: new Date().toISOString(),
      source: !harvestIsEmpty ? 'harvested' : live?.ok ? 'usage_api' : 'stale',
      ok: !harvestIsEmpty || !!live?.ok,
    };
    return merged;
  }

  /**
   * The binding window's `resetsAt` for the park logic — prefers `rateLimitType`'s window, else
   * `fiveHour`. Pure snapshot read (no HTTP): the park path needs an answer NOW, not after a 10s probe.
   */
  getResetAt(orgId: string, rateLimitType?: string): string | undefined {
    const snapshot = this.harvested.get(orgId);
    if (!snapshot) return undefined;
    const key = (rateLimitType && RATE_LIMIT_TYPE_TO_WINDOW[rateLimitType]) || 'fiveHour';
    return snapshot.windows[key]?.resetsAt;
  }

  /** `fetchLive`, cached for {@link LIVE_FLOOR_MS} so repeated `get()` calls don't hammer the endpoint. */
  private async liveSnapshot(orgId: string): Promise<OrgUsage> {
    const cached = this.liveCache.get(orgId);
    if (cached && Date.now() - cached.fetchedAtMs < LIVE_FLOOR_MS) return cached.usage;
    const usage = await this.fetchLive(orgId);
    this.liveCache.set(orgId, { usage, fetchedAtMs: Date.now() });
    return usage;
  }
}

function degradedUsage(): OrgUsage {
  return { ...EMPTY_WINDOWS, fetchedAt: new Date().toISOString(), source: 'stale', ok: false };
}

/**
 * Parse ONE `/api/oauth/usage` window entry. The response shape is UNOFFICIAL (undocumented, reverse
 * engineered) — every field is guarded, and anything missing/malformed coerces to `null` rather than
 * throwing.
 */
function parseWindow(raw: unknown): UsageWindow {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as { utilization?: unknown; resets_at?: unknown };
  const utilization = typeof w.utilization === 'number' ? w.utilization : null;
  if (utilization == null) return null;
  const resetsAtRaw = w.resets_at;
  const resetsAtMs =
    typeof resetsAtRaw === 'string' || typeof resetsAtRaw === 'number'
      ? new Date(resetsAtRaw).getTime()
      : NaN;
  if (Number.isNaN(resetsAtMs)) return null;
  return { utilization, resetsAt: new Date(resetsAtMs).toISOString() };
}

/** Parse the full `/api/oauth/usage` body — same unofficial-shape caveat as {@link parseWindow}. */
function parseUsageResponse(body: unknown): OrgUsage {
  const windows = (body as { windows?: Record<string, unknown> } | null)?.windows ?? {};
  return {
    fiveHour: parseWindow(windows.five_hour),
    sevenDay: parseWindow(windows.seven_day),
    sevenDayOpus: parseWindow(windows.seven_day_opus),
    sevenDaySonnet: parseWindow(windows.seven_day_sonnet),
    fetchedAt: new Date().toISOString(),
    source: 'usage_api',
    ok: true,
  };
}

/**
 * The `User-Agent: claude-code/<version>` the real CLI sends — read from the installed SDK's
 * `claudeCodeVersion` field so it tracks whatever version is actually vendored, rather than a value that
 * silently drifts out of date. Defensive: any failure (path layout change, missing field) falls back to a
 * hardcoded string instead of breaking the usage fetch.
 */
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
