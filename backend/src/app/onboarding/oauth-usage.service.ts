import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import type { ClaudeUsageWindowKey, OrgUsage, UsageWindow } from '@workspace/shared';
import { resetEpochToIso } from '../engine/session-limit';
import { CredentialResolver } from './credential-resolver.service';
import { TenantCredentialStore } from './tenant-credential.store';

/** The four subscription rate-limit windows the SDK/API report, in `OrgUsage`'s field names. */
type WindowKey = ClaudeUsageWindowKey;

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

const ANTHROPIC_VERSION = '2023-06-01';
/** Cheapest current model — the probe only needs a valid model to get a 200 + the rate-limit headers. */
const USAGE_PROBE_MODEL = 'claude-haiku-4-5-20251001';
/** The Claude-Code system prompt the CLI sends; without it the OAuth token is rejected off the CLI surface. */
const CLAUDE_CODE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.";
/** The `anthropic-ratelimit-unified-<prefix>-*` header window prefixes → the OrgUsage field they fill. */
const HEADER_PREFIX_TO_WINDOW: ReadonlyArray<readonly [string, WindowKey]> = [
  ['5h', 'fiveHour'],
  ['7d', 'sevenDay'],
];

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

  private readonly liveCache = new Map<string, LiveCacheEntry>();

  constructor(
    private readonly credentials: CredentialResolver,
    private readonly store: TenantCredentialStore,
  ) {}

  /**
   * PRIMARY. Fold one SDK `rate_limit_event` frame (or the engine's `kind:'rate_limit'` mirror of it)
   * into the org's snapshot. Ignores frames that don't carry a recognized window + both fields — never
   * throws, since this rides the hot turn-event path.
   */
  async applyHarvest(
    orgId: string,
    info: { status?: string; resetsAt?: number; rateLimitType?: string; utilization?: number },
  ): Promise<void> {
    try {
      // The SDK reports `resetsAt` in epoch SECONDS; `resetEpochToIso` normalizes that (and tolerates a
      // caller that already passes ms, e.g. the park sites). Drop frames with no usable reset instant.
      const resetsAt = resetEpochToIso(info.resetsAt);
      if (!resetsAt) return;
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
      await this.store.mergeClaudeUsageWindow(orgId, key, { utilization, resetsAt }, Date.now());
    } catch (err) {
      this.logger.warn(`applyHarvest failed org=${orgId}: ${err}`);
    }
  }

  /**
   * COLD/FALLBACK. The subscription session/weekly utilization rides on the `anthropic-ratelimit-unified-*`
   * RESPONSE HEADERS of any `/v1/messages` call — which, unlike the `/api/oauth/usage` endpoint, need NO
   * `user:profile` scope, so they work with the inference-scoped token we already store. We make the
   * smallest possible inference call (`max_tokens:1`) purely to read those headers. Never throws — any
   * failure (no credential, non-200, timeout) returns a degraded `{ ok:false, source:'stale' }` snapshot.
   */
  async fetchLive(orgId: string): Promise<OrgUsage> {
    try {
      const auth = await this.credentials.engineAuth(orgId, 'claude');
      if (!auth) return degradedUsage();

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${auth.secret}`,
            'anthropic-version': ANTHROPIC_VERSION,
            'anthropic-beta': 'oauth-2025-04-20',
            'User-Agent': `claude-code/${this.claudeCodeVersion}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: USAGE_PROBE_MODEL,
            max_tokens: 1,
            system: CLAUDE_CODE_SYSTEM,
            messages: [{ role: 'user', content: '.' }],
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          this.logger.warn(`usage probe failed org=${orgId}: HTTP ${res.status}`);
          return degradedUsage();
        }
        return parseUnifiedHeaders(res.headers);
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      this.logger.warn(`usage probe failed org=${orgId}: ${err}`);
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
    const snapshot = await this.store.readClaudeUsageSnapshot(orgId);
    const harvestWindows = snapshot?.windows ?? {};
    const harvestIsEmpty = Object.keys(harvestWindows).length === 0;
    const harvestIsStale = !snapshot || Date.now() - snapshot.fetchedAt >= LIVE_FLOOR_MS;

    const live = harvestIsEmpty || harvestIsStale ? await this.liveSnapshot(orgId) : undefined;

    // `fetchedAt` is the "last updated" the UI shows — the instant the SERVED data was actually captured,
    // NOT response-assembly time. Harvested windows take precedence, so their capture time (`snapshot.fetchedAt`)
    // is the meaningful stamp; fall back to the live-fetch time (now) when there's no harvest to show.
    const fetchedAt =
      !harvestIsEmpty && snapshot
        ? new Date(snapshot.fetchedAt).toISOString()
        : new Date().toISOString();

    const merged: OrgUsage = {
      fiveHour: harvestWindows.fiveHour ?? live?.fiveHour ?? null,
      sevenDay: harvestWindows.sevenDay ?? live?.sevenDay ?? null,
      sevenDayOpus: harvestWindows.sevenDayOpus ?? live?.sevenDayOpus ?? null,
      sevenDaySonnet: harvestWindows.sevenDaySonnet ?? live?.sevenDaySonnet ?? null,
      fetchedAt,
      source: !harvestIsEmpty ? 'harvested' : live?.ok ? 'usage_api' : 'stale',
      ok: !harvestIsEmpty || !!live?.ok,
    };
    return merged;
  }

  /**
   * The binding window's `resetsAt` for the park logic — prefers `rateLimitType`'s window, else
   * `fiveHour`. Pure snapshot read (no HTTP): the park path needs an answer NOW, not after a 10s probe.
   */
  async getResetAt(orgId: string, rateLimitType?: string): Promise<string | undefined> {
    const snapshot = await this.store.readClaudeUsageSnapshot(orgId);
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
 * Read ONE window from the `anthropic-ratelimit-unified-<prefix>-*` response headers. `-utilization` is a
 * 0–1 fraction (→ 0–100); `-reset` is a Unix epoch (seconds); `-status` of `rejected` means the window is
 * capped (100% even if `-utilization` is absent). Anything missing/unparseable → `null` (window omitted).
 */
function windowFromHeaders(headers: Headers, prefix: string): UsageWindow {
  const utilRaw = headers.get(`anthropic-ratelimit-unified-${prefix}-utilization`);
  const status = headers.get(`anthropic-ratelimit-unified-${prefix}-status`);
  const resetsAt = resetEpochToIso(numberOrUndefined(headers.get(`anthropic-ratelimit-unified-${prefix}-reset`)));
  if (!resetsAt) return null;

  const fraction = utilRaw != null ? Number(utilRaw) : status === 'rejected' ? 1 : null;
  if (fraction == null || Number.isNaN(fraction)) return null;
  return { utilization: Math.round(Math.min(1, Math.max(0, fraction)) * 100), resetsAt };
}

function numberOrUndefined(raw: string | null): number | undefined {
  if (raw == null) return undefined;
  const n = Number(raw);
  return Number.isNaN(n) ? undefined : n;
}

/**
 * Build the usage snapshot from a `/v1/messages` response's `anthropic-ratelimit-unified-*` headers. Only
 * the 5-hour (session) and 7-day (weekly · all-models) windows ride on these headers; the per-model Opus /
 * Sonnet windows are not exposed here, so they stay `null` and the panel simply omits them.
 */
function parseUnifiedHeaders(headers: Headers): OrgUsage {
  const windows: Record<WindowKey, UsageWindow> = { ...EMPTY_WINDOWS };
  for (const [prefix, key] of HEADER_PREFIX_TO_WINDOW) {
    windows[key] = windowFromHeaders(headers, prefix);
  }
  const ok = Boolean(windows.fiveHour ?? windows.sevenDay);
  return {
    ...windows,
    fetchedAt: new Date().toISOString(),
    source: ok ? 'usage_api' : 'stale',
    ok,
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
