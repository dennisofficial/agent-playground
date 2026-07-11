import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import type { ClaudeUsageWindowKey, OrgUsage, UsageWindow } from '@workspace/shared';
import { resetEpochToIso } from '../engine/session-limit';
import { CredentialResolver } from './credential-resolver.service';
import { TenantCredentialStore } from './tenant-credential.store';
import { UsageEventBus } from './usage-event-bus';

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
 *  - FALLBACK (`fetchLive`): Anthropic's `/api/oauth/usage` HTTP endpoint (the source Claude Code's own
 *    `/usage` panel uses), for a cold/idle org or the popover opened before any turn ran. Requires a
 *    PERSONAL (profile-scoped) Claude token from `claude login` — a `setup-token` 403s here. Best-effort
 *    and non-critical — the endpoint is undocumented; any failure degrades to `ok:false` ("unknown").
 */
@Injectable()
export class OauthUsageService {
  private readonly logger = new Logger(OauthUsageService.name);
  private readonly claudeCodeVersion = resolveClaudeCodeVersion();

  private readonly liveCache = new Map<string, LiveCacheEntry>();

  constructor(
    private readonly credentials: CredentialResolver,
    private readonly store: TenantCredentialStore,
    private readonly bus: UsageEventBus,
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
      const changed = await this.store.mergeClaudeUsageWindow(orgId, key, { utilization, resetsAt }, Date.now());
      if (changed) void this.publishHarvested(orgId);
    } catch (err) {
      this.logger.warn(`applyHarvest failed org=${orgId}: ${err}`);
    }
  }

  /**
   * COLD/FALLBACK. Fetches the org's subscription usage from Anthropic's `/api/oauth/usage` endpoint —
   * the same endpoint Claude Code's `/usage` panel calls. It returns the full window set (session 5h,
   * weekly 7d, and per-model weekly Opus/Sonnet when present) as `utilization` (0–100) + `resets_at`.
   *
   * EXPECTS A PERSONAL (profile-scoped) Claude token — i.e. one minted by the interactive `claude login`
   * OAuth flow (scope `user:profile`), NOT a `claude setup-token` (inference-only, which 403s here). The
   * endpoint is undocumented/best-effort: any failure (no credential, non-200, unparsable body) degrades
   * to `ok:false` ("unknown" in the UI) rather than throwing into a caller.
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
            'content-type': 'application/json',
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
   * Called when the org's SELECTED Claude credential changes (select / delete-selected / first-credential
   * auto-select). Drops the harvested snapshot AND the in-memory live cache so `get()` re-reads the
   * newly-selected account from scratch, then pushes a fresh snapshot to connected browsers. Best-effort:
   * the publish is fire-and-forget so it never blocks or fails the switch.
   */
  async invalidate(orgId: string): Promise<void> {
    this.liveCache.delete(orgId);
    await this.store.clearClaudeUsageSnapshot(orgId);
    void this.get(orgId)
      .then((usage) => this.bus.publish({ orgId, usage }))
      .catch(() => {});
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

  /**
   * Push the current HARVESTED snapshot to browsers after a live quota burn — harvested windows only, no HTTP
   * fetch (that rides the hot turn path). Best-effort: any failure is swallowed so it never breaks harvesting.
   */
  private async publishHarvested(orgId: string): Promise<void> {
    try {
      const snapshot = await this.store.readClaudeUsageSnapshot(orgId);
      if (!snapshot) return;
      const windows = snapshot.windows;
      const usage: OrgUsage = {
        fiveHour: windows.fiveHour ?? null,
        sevenDay: windows.sevenDay ?? null,
        sevenDayOpus: windows.sevenDayOpus ?? null,
        sevenDaySonnet: windows.sevenDaySonnet ?? null,
        fetchedAt: new Date(snapshot.fetchedAt).toISOString(),
        source: 'harvested',
        ok: true,
      };
      this.bus.publish({ orgId, usage });
    } catch (err) {
      this.logger.warn(`publishHarvested failed org=${orgId}: ${err}`);
    }
  }
}

function degradedUsage(): OrgUsage {
  return { ...EMPTY_WINDOWS, fetchedAt: new Date().toISOString(), source: 'stale', ok: false };
}

/**
 * Parse ONE `/api/oauth/usage` window entry: `{ utilization: number(0–100), resets_at: ISO-8601 }`. The
 * response shape is unofficial — every field is guarded, and anything missing/malformed → `null` (the
 * window is simply omitted from the panel).
 */
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
  return { utilization: Math.round(Math.min(100, Math.max(0, utilization))), resetsAt: new Date(resetsAtMs).toISOString() };
}

/**
 * Parse the `/api/oauth/usage` body. Windows sit at the TOP LEVEL (`{ five_hour, seven_day,
 * seven_day_opus, seven_day_sonnet }`), each `{ utilization, resets_at }` (null when that window is
 * inactive for the account); a defensive fallback also looks under `windows`/`rate_limits`.
 */
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
  const ok = Boolean(
    windows.fiveHour ?? windows.sevenDay ?? windows.sevenDayOpus ?? windows.sevenDaySonnet,
  );
  return { ...windows, fetchedAt: new Date().toISOString(), source: ok ? 'usage_api' : 'stale', ok };
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
