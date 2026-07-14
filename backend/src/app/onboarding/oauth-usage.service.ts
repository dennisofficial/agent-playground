import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import type {
  ClaudeUsageWindowKey,
  ModelUsageWindow,
  OrgUsage,
  StoredUsageWindow,
  UsageWindow,
} from '@workspace/shared';
import { resetEpochToIso } from '../engine/session-limit';
import { ClaudeCredentialStore } from './claude-credential.store';
import { CredentialRefreshService } from './credential-refresh.service';
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

/**
 * The live-usage HTTP fetch is cached for this long — the floor between real calls to Anthropic's
 * rate-limited `/api/oauth/usage`. At most ONE request per minute per org: fresh enough that opening the
 * usage card reflects a just-happened window reset, still gentle on the endpoint.
 */
const LIVE_FLOOR_MS = 60 * 1000;

/** Bound the unofficial HTTP call the same way `McpProbeService` bounds its handshake. */
const FETCH_TIMEOUT_MS = 10_000;

const FALLBACK_CLAUDE_CODE_VERSION = '2.1.204';

const errorText = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

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
  private readonly credentialLiveCache = new Map<string, LiveCacheEntry>();

  constructor(
    private readonly credentials: CredentialResolver,
    private readonly store: TenantCredentialStore,
    private readonly claudeStore: ClaudeCredentialStore,
    private readonly bus: UsageEventBus,
    private readonly credRefresh: CredentialRefreshService,
  ) {}

  /**
   * PRIMARY. Fold one SDK `rate_limit_event` frame (or the engine's `kind:'rate_limit'` mirror of it)
   * into the org's snapshot. Ignores frames that don't carry a recognized window + both fields — never
   * throws, since this rides the hot turn-event path.
   */
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
      // The SDK reports `resetsAt` in epoch SECONDS; `resetEpochToIso` normalizes that (and tolerates a
      // caller that already passes ms, e.g. the park sites). Drop frames with no usable reset instant.
      const resetsAt = resetEpochToIso(info.resetsAt);
      if (!resetsAt) return;
      // A `rejected` frame IS the hard limit — the window is full by definition, so paint it 100% even
      // when the frame omits `utilization`, and default an unlabeled rejection to the session window (the
      // binding day-to-day one). Non-rejected frames still require a real `utilization` to record.
      const rejected = info.status === 'rejected';
      const utilization = rejected
        ? 100
        : toPercentUtilization(info.utilization);
      if (utilization == null) return;
      const rateLimitType =
        info.rateLimitType ?? (rejected ? 'five_hour' : undefined);
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
      // Route the org's SELECTED personal credential through the ONE serialized refresh core before the fetch,
      // so an open Settings tab can't race a turn/keep-alive on the rotating refresh token — and a dead token
      // is surfaced as needs_reauth by the core rather than silently degraded. Setup tokens are static (no refresh).
      let secret = auth.secret;
      if (auth.kind === 'personal' && auth.refreshBack?.credentialId) {
        try {
          secret = await this.credRefresh.ensureFresh(
            orgId,
            auth.refreshBack.credentialId,
          );
        } catch (err) {
          this.logger.warn(
            `usage refresh failed org=${orgId}: ${errorText(err)}`,
          );
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

  /** Issue the actual `/api/oauth/usage` GET with a resolved bearer access token; degrade on any non-200/parse failure. Shared by the org-level (`fetchLive`) and per-credential paths. */
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

  /**
   * The per-credential usage `GET /web/orgs/:orgId/claude-credentials/:id/usage` serves. ALWAYS resolves
   * through THAT credential's own token (never the org-level harvested snapshot, which is keyed to whichever
   * credential was selected when turns ran). Setup tokens and unknown ids degrade to `ok:false` (d1/d3).
   */
  async getForCredential(
    orgId: string,
    credentialId: string,
  ): Promise<OrgUsage> {
    const row = (await this.claudeStore.list(orgId)).find(
      (r) => r.id === credentialId,
    );
    if (!row || row.kind !== 'personal') return degradedUsage();
    return this.liveCredentialSnapshot(orgId, credentialId);
  }

  /**
   * The merged snapshot `GET /web/orgs/:orgId/usage` serves: whichever source (harvest vs live) was
   * captured MORE RECENTLY wins, per-window, and `fetchedAt` is stamped honestly to that source's own
   * capture time — never response-assembly time. A harvest only ever carries the ONE window a
   * `rate_limit_event` reported, so the fresher source only shadows the windows it actually has; the other
   * source fills the rest. The HTTP fallback is throttled to at most once per {@link LIVE_FLOOR_MS}. Always
   * resolves to a well-formed `OrgUsage` — `ok:false` when nothing is known from either source.
   */
  async get(orgId: string): Promise<OrgUsage> {
    const snapshot = await this.store.readClaudeUsageSnapshot(orgId);
    const selectedId = await this.claudeStore.getSelectedCredentialId(orgId);
    // Trust the harvested snapshot ONLY when it was produced by the currently-selected credential.
    // A snapshot tagged to a now-deselected account (or an untagged legacy/reattach snapshot) must
    // not shadow the live per-account read — that is the account-switch staleness bug.
    const harvestTrusted =
      !!snapshot?.credentialId && snapshot.credentialId === selectedId;
    // Drop any harvested window whose reset instant has already passed: the window has rolled over, so its
    // stored utilization (e.g. a latched 100% from a session-limit hit) is stale and must NOT keep shadowing
    // the live snapshot's fresh post-reset value — otherwise a maxed window never visibly "resets to 0".
    const now = Date.now();
    const harvestWindows: Partial<
      Record<ClaudeUsageWindowKey, StoredUsageWindow>
    > = {};
    if (harvestTrusted) {
      for (const [key, w] of Object.entries(snapshot?.windows ?? {})) {
        if (w && new Date(w.resetsAt).getTime() > now)
          harvestWindows[key as ClaudeUsageWindowKey] = w;
      }
    }
    const harvestIsEmpty = Object.keys(harvestWindows).length === 0;

    // Always consult the live snapshot, which is throttled to one real HTTP call per LIVE_FLOOR_MS by
    // `liveSnapshot`'s cache — so this is cheap. A harvest only ever carries the ONE window a
    // `rate_limit_event` reported (almost always the session/fiveHour), so the live snapshot is what fills
    // the OTHER windows (Weekly/Opus/Sonnet). Gating the live read on "harvest empty or stale" (the old
    // behavior) meant a single fresh session harvest blanked every other row until it went stale.
    const live = await this.liveSnapshot(orgId);

    // Serve the FRESHER source. A degraded live snapshot stamps `fetchedAt = now` (see `degradedUsage`), so
    // it must never be mistaken for a "just captured" competitor — only a `live.ok` snapshot has a real
    // capture time. Prefer harvest per-window only when it's present AND at least as fresh as a usable live
    // read: during a turn `applyHarvest` stamps `snapshot.fetchedAt = now`, so harvest wins (real-time SSE
    // preserved); on an idle open harvest is hours old while live was just fetched, so live wins → "just now".
    const hasHarvest = !harvestIsEmpty;
    const hasLive = live.ok;
    const harvestAtMs = snapshot?.fetchedAt;
    const liveAtMs = new Date(live.fetchedAt).getTime();
    const harvestWins =
      hasHarvest && (!hasLive || (harvestAtMs ?? 0) >= liveAtMs);
    const liveWins = !harvestWins && hasLive;

    // Whichever source won leads per-window; the other backfills the windows the winner doesn't carry.
    const pick = (key: ClaudeUsageWindowKey): UsageWindow =>
      harvestWins
        ? (harvestWindows[key] ?? live[key] ?? null)
        : (live[key] ?? harvestWindows[key] ?? null);

    // Stamp the served data's own capture time: the harvest snapshot's when harvest won, the live-fetch time
    // when live won, else assembly time (both sources unknown → degraded).
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
      // Per-model weekly caps (e.g. Fable) are never harvested — they only come from the live snapshot.
      modelWindows: live.modelWindows ?? [],
      fetchedAt,
      source: harvestWins ? 'harvested' : liveWins ? 'usage_api' : 'stale',
      ok: harvestWins || liveWins,
    };
    return this.withAccount(orgId, merged);
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
  async getResetAt(
    orgId: string,
    rateLimitType?: string,
  ): Promise<string | undefined> {
    const snapshot = await this.store.readClaudeUsageSnapshot(orgId);
    if (!snapshot) return undefined;
    const key =
      (rateLimitType && RATE_LIMIT_TYPE_TO_WINDOW[rateLimitType]) || 'fiveHour';
    return snapshot.windows[key]?.resetsAt;
  }

  /** `fetchLive`, cached for {@link LIVE_FLOOR_MS} so repeated `get()` calls don't hammer the endpoint. */
  private async liveSnapshot(orgId: string): Promise<OrgUsage> {
    const cached = this.liveCache.get(orgId);
    if (cached && Date.now() - cached.fetchedAtMs < LIVE_FLOOR_MS)
      return cached.usage;
    const usage = await this.fetchLive(orgId);
    this.liveCache.set(orgId, { usage, fetchedAtMs: Date.now() });
    return usage;
  }

  /**
   * Push a fresh snapshot to browsers after a harvested-window change (a live quota burn during a turn).
   * Publishes the SAME merged shape the REST endpoint serves — via {@link get}, so the pushed frame carries
   * the just-harvested window AND the other windows filled from the throttled live snapshot (else a
   * session-only harvest would blank Weekly/Opus/Sonnet on the client) plus the account header. Best-effort:
   * any failure is swallowed so it never breaks harvesting.
   */
  private async publishHarvested(orgId: string): Promise<void> {
    try {
      this.bus.publish({ orgId, usage: await this.get(orgId) });
    } catch (err) {
      this.logger.warn(
        `publishHarvested failed org=${orgId}: ${errorText(err)}`,
      );
    }
  }

  /**
   * Stamp the panel-header fields (`accountLabel` = the selected account's email, falling back to its
   * credential label; `plan` = a display label from its subscription type) onto a usage snapshot. The
   * single place both the REST `get()` response and the SSE push payload are enriched, so the header never
   * blanks between an initial fetch and a live push. Best-effort: any lookup failure leaves the header
   * fields absent (the UI falls back to the neutral title) rather than throwing.
   */
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

  /** `fetchLiveForCredential`, cached per credential id for {@link LIVE_FLOOR_MS} so repeat settings visits don't re-hit the endpoint. */
  private async liveCredentialSnapshot(
    orgId: string,
    credentialId: string,
  ): Promise<OrgUsage> {
    const cached = this.credentialLiveCache.get(credentialId);
    if (cached && Date.now() - cached.fetchedAtMs < LIVE_FLOOR_MS)
      return cached.usage;
    const usage = await this.fetchLiveForCredential(orgId, credentialId);
    this.credentialLiveCache.set(credentialId, {
      usage,
      fetchedAtMs: Date.now(),
    });
    return usage;
  }

  /**
   * Resolve a specific credential's usage through the ONE serialized refresh core (`ensureFresh`), which
   * refreshes on-demand under the cross-instance row lock when the token is near expiry and flips the row to
   * `needs_reauth` on a hard failure — so this Settings path can no longer race a turn/keep-alive on the
   * rotating refresh token or silently swallow a dead-token failure. Best-effort: any failure (including
   * `CredentialNeedsReauthError`, after the row is already marked) degrades to `ok:false`.
   */
  private async fetchLiveForCredential(
    orgId: string,
    credentialId: string,
  ): Promise<OrgUsage> {
    let secret: string;
    try {
      secret = await this.credRefresh.ensureFresh(orgId, credentialId);
    } catch (err) {
      this.logger.warn(
        `cred usage refresh failed ${credentialId}: ${errorText(err)}`,
      );
      return degradedUsage();
    }
    try {
      const accessToken = bearerTokenFromSecret(secret, 'personal');
      if (!accessToken) return degradedUsage();
      return await this.fetchUsageWithToken(accessToken);
    } catch (err) {
      this.logger.warn(
        `cred usage fetch failed ${credentialId}: ${errorText(err)}`,
      );
      return degradedUsage();
    }
  }
}

/**
 * A subscription-type string (e.g. `max`, `pro`) → the header badge label ("Max plan", "Pro plan").
 * Undefined for a null/blank type (setup-tokens carry none → no badge). A value that already reads like a
 * plan is titlecased as-is rather than gaining a second "plan".
 */
function planLabel(
  subscriptionType: string | null | undefined,
): string | undefined {
  const t = subscriptionType?.trim();
  if (!t) return undefined;
  const titled = t.charAt(0).toUpperCase() + t.slice(1);
  return /plan/i.test(t) ? titled : `${titled} plan`;
}

/**
 * Normalize a `rate_limit_event.utilization` to the 0–100 PERCENT scale the rest of the pipeline uses (the
 * live `/api/oauth/usage` endpoint, the stored snapshot, and the UI all speak 0–100). The SDK's
 * `rate_limit_event` reports utilization as a 0–1 FRACTION (e.g. `0.9` for a 90%-used window) — stored raw
 * it renders as `round(0.9)` = 1%, the wrong number, and shadows the correct live value. Convert the
 * fraction to a percent; a value already `> 1` is treated as an already-percent scale (defensive against
 * CLI/SDK drift) and passes through. Clamped + rounded to 0–100 to match `parseWindow`. Undefined in → undefined out.
 */
export function toPercentUtilization(
  utilization: number | undefined,
): number | undefined {
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

/**
 * Parse the per-MODEL weekly caps out of the usage body's `limits[]` array — the `weekly_scoped` entries
 * (e.g. `{ kind:'weekly_scoped', percent, resets_at, scope:{ model:{ display_name:'Fable' } } }`). The flat
 * top-level `seven_day_*` keys don't carry these. `percent` is already a 0–100 value here (NOT the SDK
 * fraction). Anything malformed is skipped. Returns [] when there's no usable array.
 */
export function parseModelWindows(
  root: Record<string, unknown>,
): ModelUsageWindow[] {
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
    const label = (
      l.scope as { model?: { display_name?: unknown } } | undefined
    )?.model?.display_name;
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

/**
 * The value to place after `Bearer ` for a credential's usage call. A `setup-token`'s secret IS the raw
 * token; a `personal` credential's secret is a `{claudeAiOauth:{accessToken,…}}` JSON blob, so pull the
 * accessToken out of it. Null when the personal blob is malformed or missing its access token.
 */
function bearerTokenFromSecret(
  secret: string,
  kind: 'setup-token' | 'personal' | undefined,
): string | null {
  if (kind !== 'personal') return secret;
  try {
    const t = (
      JSON.parse(secret) as { claudeAiOauth?: { accessToken?: unknown } }
    ).claudeAiOauth?.accessToken;
    return typeof t === 'string' && t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

/**
 * Parse ONE `/api/oauth/usage` window entry: `{ utilization: number(0–100), resets_at: ISO-8601 }`. The
 * response shape is unofficial — every field is guarded, and anything missing/malformed → `null` (the
 * window carries no data: the always-on Session/Weekly rows fall back to their unknown state, while
 * dynamic windows (Opus/Sonnet/per-model) are simply omitted from the panel).
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
  return {
    utilization: Math.round(Math.min(100, Math.max(0, utilization))),
    resetsAt: new Date(resetsAtMs).toISOString(),
  };
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
  const modelWindows = parseModelWindows(root);
  // `ok` means "the endpoint responded" — NOT "we have at least one fixed window". A brand-new account
  // that has used nothing yet returns every fixed window null (often with only per-model rows), yet the
  // fetch fully succeeded: that is a fresh, not-started account, not an outage. Reaching here already means
  // a 200 + parseable body, so this is always a successful response. Marking it `ok` lets the UI tell
  // "Waiting for next turn" (responded, window not started) apart from "Usage unavailable" (a real fetch
  // failure, which routes through `degradedUsage()` with `ok:false`).
  return {
    ...windows,
    fetchedAt: new Date().toISOString(),
    source: 'usage_api',
    ok: true,
    modelWindows,
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
