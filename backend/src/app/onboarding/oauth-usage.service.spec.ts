import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeUsageSnapshot, ClaudeUsageWindowKey, StoredUsageWindow } from '@workspace/shared';
import type { EnvService } from '@core/config/env/env.service';
import { OauthUsageService, parseModelWindows, toPercentUtilization } from './oauth-usage.service';
import type { ClaudeCredentialStore, ClaudeCredentialSummary } from './claude-credential.store';
import type { CredentialRefreshService } from './credential-refresh.service';
import type { CredentialResolver } from './credential-resolver.service';
import type { TenantCredentialStore } from './tenant-credential.store';
import { UsageEventBus, type UsageChange } from './usage-event-bus';

type SelectedDisplay = { accountEmail: string | null; subscriptionType: string | null; label: string };

type FakeCredentialRow = { id: string; kind: 'setup_token' | 'personal'; secret: string };

/**
 * Minimal in-memory stand-in for `ClaudeCredentialStore`'s full surface these tests need: the
 * per-credential read/write-back path (`list`, `getDecryptedById`, `advanceClaudeCredential`) AND the
 * selected-account display header (`getSelectedDisplay`).
 */
class FakeClaudeStore {
  readonly advanceCalls: Array<{ orgId: string; credentialId: string; secret: string }> = [];

  constructor(
    private readonly rows: FakeCredentialRow[] = [],
    private readonly display: SelectedDisplay | null = null,
  ) {}

  getSelectedDisplay(_orgId: string): Promise<SelectedDisplay | null> {
    return Promise.resolve(this.display);
  }

  list(_orgId: string): Promise<ClaudeCredentialSummary[]> {
    return Promise.resolve(
      this.rows.map((row) => ({
        id: row.id,
        label: row.id,
        kind: row.kind,
        status: 'active',
        expiresAt: null,
        accountEmail: null,
        isSelected: false,
      })),
    );
  }

  getDecryptedById(_orgId: string, id: string): Promise<FakeCredentialRow | null> {
    return Promise.resolve(this.rows.find((row) => row.id === id) ?? null);
  }

  advanceClaudeCredential(orgId: string, credentialId: string, secret: string): Promise<void> {
    this.advanceCalls.push({ orgId, credentialId, secret });
    return Promise.resolve();
  }
}

/**
 * Minimal stand-in for `CredentialRefreshService`: the usage paths now resolve a credential's token through
 * `ensureFresh` (the ONE serialized refresh core) instead of an inline refresh. This fake returns the stored
 * blob straight from the `FakeClaudeStore`, mirroring the healthy/no-op case (`ensureFresh` returns the
 * stored secret when the token isn't near expiry).
 */
class FakeCredRefresh {
  constructor(private readonly claudeStore: FakeClaudeStore) {}

  async ensureFresh(orgId: string, credentialId: string): Promise<string> {
    const row = await this.claudeStore.getDecryptedById(orgId, credentialId);
    if (!row) throw new Error(`credential ${credentialId} not found for org ${orgId}`);
    return row.secret;
  }
}

/**
 * Minimal in-memory stand-in for `TenantCredentialStore`'s (plaintext) usage-snapshot methods, mirroring
 * the real store's merge + skip-if-unchanged semantics so these tests exercise the same write-through
 * contract `applyHarvest`/`get` depend on in production.
 */
class FakeCredentialStore {
  constructor(private readonly snapshots = new Map<string, ClaudeUsageSnapshot>()) {}

  readClaudeUsageSnapshot(orgId: string): Promise<ClaudeUsageSnapshot | null> {
    return Promise.resolve(this.snapshots.get(orgId) ?? null);
  }

  mergeClaudeUsageWindow(
    orgId: string,
    key: ClaudeUsageWindowKey,
    window: StoredUsageWindow,
    fetchedAt: number,
  ): Promise<boolean> {
    const snapshot = this.snapshots.get(orgId) ?? { windows: {}, fetchedAt: 0 };
    const existing = snapshot.windows[key];
    if (existing && existing.utilization === window.utilization && existing.resetsAt === window.resetsAt) {
      return Promise.resolve(false);
    }
    this.snapshots.set(orgId, {
      windows: { ...snapshot.windows, [key]: window },
      fetchedAt,
    });
    return Promise.resolve(true);
  }

  clearClaudeUsageSnapshot(orgId: string): Promise<void> {
    this.snapshots.delete(orgId);
    return Promise.resolve();
  }
}

/** Await a macrotask turn so a fire-and-forget `.then(...)` publish (invalidate/publishHarvested) — which chains several `await`s — lands before assertions. */
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** No stored engine auth — `get()`'s HTTP fallback degrades cleanly instead of making a real network call. */
const NO_ENGINE_AUTH: Pick<CredentialResolver, 'engineAuth'> = {
  engineAuth: () => Promise.resolve(undefined),
};

/** A `personal` credential's decrypted secret shape: a `{claudeAiOauth:{…}}` JSON blob. */
function personalSecret(p: { accessToken: string; refreshToken: string; expiresAt: number }): string {
  return JSON.stringify({ claudeAiOauth: p });
}

/** A well-formed `/api/oauth/usage` body with just the five-hour window populated. */
function usageBody(utilization: number, resetsAt: string): unknown {
  return { five_hour: { utilization, resets_at: resetsAt } };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

/**
 * applyHarvest writes through to the (fake) durable store; get() serves the harvested snapshot without HTTP
 * when it's fresh. Also returns the service's `UsageEventBus` (and a running list of everything it
 * published) and the `FakeClaudeStore` it was built with, so tests can assert on realtime fan-out and
 * per-credential write-back.
 */
function makeService(
  opts: {
    store?: FakeCredentialStore;
    claudeStore?: FakeClaudeStore;
    selectedDisplay?: SelectedDisplay | null;
  } = {},
): { svc: OauthUsageService; bus: UsageEventBus; published: UsageChange[]; claudeStore: FakeClaudeStore } {
  const store = opts.store ?? new FakeCredentialStore();
  const claudeStore = opts.claudeStore ?? new FakeClaudeStore([], opts.selectedDisplay ?? null);
  const bus = new UsageEventBus();
  const published: UsageChange[] = [];
  bus.stream$.subscribe((e) => published.push(e));
  const credRefresh = new FakeCredRefresh(claudeStore);
  const svc = new OauthUsageService(
    NO_ENGINE_AUTH as unknown as CredentialResolver,
    store as unknown as TenantCredentialStore,
    claudeStore as unknown as ClaudeCredentialStore,
    bus,
    { get: () => undefined } as unknown as EnvService,
    credRefresh as unknown as CredentialRefreshService,
  );
  return { svc, bus, published, claudeStore };
}

describe('OauthUsageService.applyHarvest', () => {
  it('paints the session window full on a rejected frame that omits utilization + window', async () => {
    const { svc } = makeService();
    const resetsAt = Date.now() + 60 * 60 * 1000;
    await svc.applyHarvest('org1', { status: 'rejected', resetsAt });

    const usage = await svc.get('org1');
    expect(usage.ok).toBe(true);
    expect(usage.source).toBe('harvested');
    expect(usage.fiveHour).toEqual({
      utilization: 100,
      resetsAt: new Date(resetsAt).toISOString(),
    });
  });

  it('paints the named window full on a rejected frame with a rateLimitType', async () => {
    const { svc } = makeService();
    const resetsAt = Date.now() + 60 * 60 * 1000;
    await svc.applyHarvest('org1', {
      status: 'rejected',
      rateLimitType: 'seven_day',
      resetsAt,
    });

    const usage = await svc.get('org1');
    expect(usage.sevenDay).toEqual({
      utilization: 100,
      resetsAt: new Date(resetsAt).toISOString(),
    });
    expect(usage.fiveHour).toBeNull();
  });

  it('normalizes an epoch-SECONDS resetsAt from a harvested frame (not 1970)', async () => {
    const { svc } = makeService();
    // A FUTURE epoch in SECONDS (10-digit), so it survives the past-reset expiry and this test stays about
    // the seconds→ms normalization, not window expiry.
    const seconds = Math.floor((Date.now() + 5 * 60 * 60 * 1000) / 1000);
    await svc.applyHarvest('org1', {
      status: 'rejected',
      rateLimitType: 'five_hour',
      resetsAt: seconds,
    });
    const usage = await svc.get('org1');
    expect(usage.fiveHour?.resetsAt).toBe(new Date(seconds * 1000).toISOString());
    // The bug this guards is a seconds value mis-read as ms → 1970; assert it landed in the present era.
    expect(new Date(usage.fiveHour!.resetsAt).getUTCFullYear()).toBeGreaterThan(2020);
  });

  it('records a non-rejected frame at its reported utilization', async () => {
    const { svc } = makeService();
    const resetsAt = Date.now() + 60 * 60 * 1000;
    await svc.applyHarvest('org1', {
      status: 'allowed_warning',
      rateLimitType: 'five_hour',
      utilization: 82,
      resetsAt,
    });

    const usage = await svc.get('org1');
    expect(usage.fiveHour?.utilization).toBe(82);
  });

  it('ignores a non-rejected frame with no utilization (nothing to record)', async () => {
    const { svc } = makeService();
    // Must not throw and must not create a window from a bare allowed frame.
    await svc.applyHarvest('org1', {
      status: 'allowed',
      rateLimitType: 'five_hour',
      resetsAt: Date.now(),
    });
    const usage = await svc.get('org1');
    expect(usage.fiveHour).toBeNull();
  });

  it('ignores a frame with no resetsAt', async () => {
    const { svc } = makeService();
    await svc.applyHarvest('org1', { status: 'rejected', utilization: 100 });
    const usage = await svc.get('org1');
    expect(usage.ok).toBe(false);
  });

  it('durably writes through to the store and is readable by a fresh service instance', async () => {
    const store = new FakeCredentialStore();
    const { svc } = makeService({ store });
    const resetsAt = Date.now() + 60 * 60 * 1000;
    await svc.applyHarvest('org1', {
      status: 'rejected',
      rateLimitType: 'seven_day_opus',
      resetsAt,
    });

    const snapshot = await store.readClaudeUsageSnapshot('org1');
    expect(snapshot?.windows.sevenDayOpus).toEqual({
      utilization: 100,
      resetsAt: new Date(resetsAt).toISOString(),
    });

    // A brand-new service instance backed by the SAME store sees the harvest — proving durability
    // isn't tied to any in-process state on `svc`.
    const { svc: freshSvc } = makeService({ store });
    const usage = await freshSvc.get('org1');
    expect(usage.sevenDayOpus).toEqual({
      utilization: 100,
      resetsAt: new Date(resetsAt).toISOString(),
    });
  });
});

describe('OauthUsageService realtime publish', () => {
  it('publishes exactly one UsageEventBus frame for a CHANGED harvested window', async () => {
    const { svc, published } = makeService();
    const resetsAt = Date.now() + 60 * 60 * 1000;
    await svc.applyHarvest('org1', {
      status: 'rejected',
      rateLimitType: 'five_hour',
      resetsAt,
    });
    await flushMicrotasks();

    expect(published).toHaveLength(1);
    expect(published[0]?.orgId).toBe('org1');
    expect(published[0]?.usage.fiveHour).toEqual({
      utilization: 100,
      resetsAt: new Date(resetsAt).toISOString(),
    });
  });

  it('does not publish an additional frame when the SAME window is re-applied unchanged', async () => {
    const { svc, published } = makeService();
    const resetsAt = Date.now() + 60 * 60 * 1000;
    const frame = { status: 'rejected' as const, rateLimitType: 'five_hour', resetsAt };
    await svc.applyHarvest('org1', frame);
    await flushMicrotasks();
    await svc.applyHarvest('org1', frame);
    await flushMicrotasks();

    expect(published).toHaveLength(1);
  });

  it('invalidate() clears the harvested snapshot so get() no longer serves the stale window', async () => {
    const store = new FakeCredentialStore();
    const { svc } = makeService({ store });
    const resetsAt = Date.now() + 60 * 60 * 1000;
    await svc.applyHarvest('org1', {
      status: 'rejected',
      rateLimitType: 'five_hour',
      resetsAt,
    });
    expect(await store.readClaudeUsageSnapshot('org1')).not.toBeNull();

    await svc.invalidate('org1');
    await flushMicrotasks();

    expect(await store.readClaudeUsageSnapshot('org1')).toBeNull();
    const usage = await svc.get('org1');
    expect(usage.fiveHour).toBeNull();
    expect(usage.source).not.toBe('harvested');
  });

  it('invalidate() emits a fresh UsageEventBus frame', async () => {
    const store = new FakeCredentialStore();
    const { svc, published } = makeService({ store });
    await svc.applyHarvest('org1', {
      status: 'rejected',
      rateLimitType: 'five_hour',
      resetsAt: Date.now() + 60 * 60 * 1000,
    });
    await flushMicrotasks();
    published.length = 0; // only care about the invalidate publish from here on

    await svc.invalidate('org1');
    await flushMicrotasks();

    expect(published.length).toBeGreaterThanOrEqual(1);
    const last = published[published.length - 1] as UsageChange;
    expect(last.orgId).toBe('org1');
    expect(last.usage.fiveHour).toBeNull();
  });
});

describe('toPercentUtilization (rate_limit_event 0-1 fraction → 0-100 percent)', () => {
  it('scales a 0-1 fraction to a 0-100 percent', () => {
    expect(toPercentUtilization(0.9)).toBe(90);
    expect(toPercentUtilization(0.836)).toBe(84);
    expect(toPercentUtilization(0)).toBe(0);
    expect(toPercentUtilization(1)).toBe(100);
  });
  it('passes an already-percent value (>1) through, clamped to 0-100', () => {
    expect(toPercentUtilization(83)).toBe(83);
    expect(toPercentUtilization(150)).toBe(100);
  });
  it('is undefined for undefined input', () => {
    expect(toPercentUtilization(undefined)).toBeUndefined();
  });
});

describe('OauthUsageService.applyHarvest scale', () => {
  it('records a fractional rate_limit_event utilization as a whole percent (0.9 → 90, not 1)', async () => {
    const store = new FakeCredentialStore();
    const { svc } = makeService({ store });
    await svc.applyHarvest('org1', {
      status: 'allowed',
      rateLimitType: 'five_hour',
      resetsAt: Math.floor((Date.now() + 3 * 60 * 60 * 1000) / 1000), // epoch SECONDS
      utilization: 0.9,
    });
    const usage = await svc.get('org1');
    expect(usage.fiveHour?.utilization).toBe(90);
  });
});

describe('OauthUsageService.get harvested-window expiry', () => {
  it('drops a harvested window whose reset has already passed (a latched limit does not stick past reset)', async () => {
    const store = new FakeCredentialStore();
    const { svc } = makeService({ store });
    await store.mergeClaudeUsageWindow(
      'org1',
      'fiveHour',
      { utilization: 100, resetsAt: new Date(Date.now() - 60_000).toISOString() },
      Date.now(),
    );
    const usage = await svc.get('org1');
    // expired harvest ignored; live is degraded here (NO_ENGINE_AUTH) so the window falls through to null
    expect(usage.fiveHour).toBeNull();
  });

  it('still serves a harvested window whose reset is in the future', async () => {
    const store = new FakeCredentialStore();
    const { svc } = makeService({ store });
    await store.mergeClaudeUsageWindow(
      'org1',
      'fiveHour',
      { utilization: 100, resetsAt: new Date(Date.now() + 60 * 60_000).toISOString() },
      Date.now(),
    );
    const usage = await svc.get('org1');
    expect(usage.fiveHour?.utilization).toBe(100);
  });
});

describe('parseModelWindows (usage API limits[] → per-model weekly rows)', () => {
  it('extracts a weekly_scoped model entry (Fable) with its 0-100 percent and null reset', () => {
    const root = {
      limits: [
        { kind: 'session', group: 'session', percent: 94, resets_at: '2026-07-11T10:10:00Z' },
        { kind: 'weekly_all', group: 'weekly', percent: 59, resets_at: '2026-07-12T09:00:00Z' },
        {
          kind: 'weekly_scoped',
          group: 'weekly',
          percent: 0,
          resets_at: null,
          scope: { model: { id: null, display_name: 'Fable' }, surface: null },
        },
      ],
    };
    expect(parseModelWindows(root)).toEqual([{ label: 'Fable', utilization: 0, resetsAt: null }]);
  });

  it('ignores non-scoped limits, malformed entries, and a missing/necessarily-array field', () => {
    expect(parseModelWindows({})).toEqual([]);
    expect(parseModelWindows({ limits: 'nope' })).toEqual([]);
    expect(
      parseModelWindows({
        limits: [
          { kind: 'weekly_scoped', percent: 12 }, // no scope.model.display_name -> skipped
          { kind: 'weekly_scoped', percent: 'x', scope: { model: { display_name: 'Bad' } } }, // percent not a number
          { kind: 'session', percent: 94 },
        ],
      }),
    ).toEqual([]);
  });

  it('clamps + rounds the model percent (already 0-100, not the SDK fraction)', () => {
    const root = {
      limits: [
        { kind: 'weekly_scoped', percent: 150.7, scope: { model: { display_name: 'A' } } },
        { kind: 'weekly_scoped', percent: 33.4, resets_at: '2026-07-12T09:00:00Z', scope: { model: { display_name: 'B' } } },
      ],
    };
    expect(parseModelWindows(root)).toEqual([
      { label: 'A', utilization: 100, resetsAt: null },
      { label: 'B', utilization: 33, resetsAt: '2026-07-12T09:00:00Z' },
    ]);
  });
});

describe('OauthUsageService account header', () => {
  it('stamps accountLabel (email) + plan from the selected credential onto get() and the push', async () => {
    const { svc, published } = makeService({
      selectedDisplay: {
        accountEmail: 'dennis@atlas.dev',
        subscriptionType: 'max',
        label: 'Dennis personal',
      },
    });
    await svc.applyHarvest('org1', {
      status: 'rejected',
      rateLimitType: 'five_hour',
      resetsAt: Date.now() + 60 * 60 * 1000,
    });
    await flushMicrotasks();

    const usage = await svc.get('org1');
    expect(usage.accountLabel).toBe('dennis@atlas.dev');
    expect(usage.plan).toBe('Max plan');
    // the harvested push carries the same header
    expect(published[published.length - 1]?.usage.accountLabel).toBe('dennis@atlas.dev');
    expect(published[published.length - 1]?.usage.plan).toBe('Max plan');
  });

  it('falls back to the credential label and omits the plan for a setup-token (no email / no plan)', async () => {
    const { svc } = makeService({
      selectedDisplay: {
        accountEmail: null,
        subscriptionType: null,
        label: 'Imported setup-token',
      },
    });
    const usage = await svc.get('org1');
    expect(usage.accountLabel).toBe('Imported setup-token');
    expect(usage.plan).toBeUndefined();
  });

  it('leaves the header fields absent when no credential is selected', async () => {
    const { svc } = makeService(); // selectedDisplay defaults to null
    const usage = await svc.get('org1');
    expect(usage.accountLabel).toBeUndefined();
    expect(usage.plan).toBeUndefined();
  });
});

describe('OauthUsageService.getForCredential', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('degrades a setup_token credential without hitting the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const claudeStore = new FakeClaudeStore([
      { id: 'cred1', kind: 'setup_token', secret: 'sk-ant-oat-raw' },
    ]);
    const { svc } = makeService({ claudeStore });

    const usage = await svc.getForCredential('org1', 'cred1');

    expect(usage.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('degrades an unknown credential id without hitting the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { svc } = makeService({ claudeStore: new FakeClaudeStore([]) });

    const usage = await svc.getForCredential('org1', 'missing-cred');

    expect(usage.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches a personal credential’s OWN live usage via its access token, and never writes back an unexpired token', async () => {
    const resetsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const fetchMock = vi.fn((url: string, init: RequestInit) => {
      expect(url).toBe('https://api.anthropic.com/api/oauth/usage');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer at-personal');
      return jsonResponse(200, usageBody(42, resetsAt));
    });
    vi.stubGlobal('fetch', fetchMock);
    const claudeStore = new FakeClaudeStore([
      {
        id: 'cred1',
        kind: 'personal',
        secret: personalSecret({
          accessToken: 'at-personal',
          refreshToken: 'rt-personal',
          expiresAt: Date.now() + 60 * 60 * 1000,
        }),
      },
    ]);
    const { svc } = makeService({ claudeStore });

    const usage = await svc.getForCredential('org1', 'cred1');

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(usage.ok).toBe(true);
    expect(usage.fiveHour).toEqual({ utilization: 42, resetsAt: new Date(resetsAt).toISOString() });
    expect(claudeStore.advanceCalls).toHaveLength(0);
  });

  it('never routes the per-credential fetch through the org-level harvested snapshot', async () => {
    // A stale/absent harvest for the org must not short-circuit or otherwise influence the per-credential
    // path — it always live-fetches THIS credential's own token.
    const store = new FakeCredentialStore();
    await store.mergeClaudeUsageWindow(
      'org1',
      'fiveHour',
      { utilization: 99, resetsAt: new Date().toISOString() },
      Date.now(),
    );
    const resetsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => jsonResponse(200, usageBody(7, resetsAt))),
    );
    const claudeStore = new FakeClaudeStore([
      {
        id: 'cred1',
        kind: 'personal',
        secret: personalSecret({
          accessToken: 'at-personal',
          refreshToken: 'rt-personal',
          expiresAt: Date.now() + 60 * 60 * 1000,
        }),
      },
    ]);
    const { svc } = makeService({ store, claudeStore });

    const usage = await svc.getForCredential('org1', 'cred1');

    expect(usage.fiveHour?.utilization).toBe(7);
  });
});
