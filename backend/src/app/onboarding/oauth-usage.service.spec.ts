import type {
  ClaudeUsageSnapshot,
  ClaudeUsageWindowKey,
  StoredUsageWindow,
} from '@workspace/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeCredentialStore, ClaudeCredentialSummary } from './claude-credential.store';
import type { CredentialRefreshService } from './credential-refresh.service';
import type { CredentialResolver } from './credential-resolver.service';
import { OauthUsageService, parseModelWindows, toPercentUtilization } from './oauth-usage.service';
import type { TenantCredentialStore } from './tenant-credential.store';
import { UsageEventBus, type UsageChange } from './usage-event-bus';

type SelectedDisplay = {
  accountEmail: string | null;
  subscriptionType: string | null;
  label: string;
};

type FakeCredentialRow = {
  id: string;
  kind: 'setup_token' | 'personal';
  secret: string;
};

/**
 * Minimal in-memory stand-in for `ClaudeCredentialStore`'s full surface these tests need: the
 * per-credential read/write-back path (`list`, `getDecryptedById`, `advanceClaudeCredential`), the
 * selected-account display header (`getSelectedDisplay`), and the bare selected-id getter
 * (`getSelectedCredentialId`) `get()` now uses to gate harvest trust.
 */
class FakeClaudeStore {
  readonly advanceCalls: Array<{
    orgId: string;
    credentialId: string;
    secret: string;
  }> = [];

  constructor(
    private readonly rows: FakeCredentialRow[] = [],
    private readonly display: SelectedDisplay | null = null,
    private selectedCredentialId: string | null = null,
  ) {}

  getSelectedDisplay(_orgId: string): Promise<SelectedDisplay | null> {
    return Promise.resolve(this.display);
  }

  getSelectedCredentialId(_orgId: string): Promise<string | null> {
    return Promise.resolve(this.selectedCredentialId);
  }

  setSelectedCredentialId(id: string | null): void {
    this.selectedCredentialId = id;
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
    credentialId?: string,
  ): Promise<boolean> {
    let snapshot = this.snapshots.get(orgId) ?? { windows: {}, fetchedAt: 0 };
    // Mirrors the real store's single-account invariant: a harvest from a DIFFERENT credential resets.
    if (snapshot.credentialId !== credentialId) {
      snapshot = { windows: {}, fetchedAt: 0, credentialId };
    }
    const existing = snapshot.windows[key];
    if (
      existing &&
      existing.utilization === window.utilization &&
      existing.resetsAt === window.resetsAt
    ) {
      return Promise.resolve(false);
    }
    this.snapshots.set(orgId, {
      windows: { ...snapshot.windows, [key]: window },
      fetchedAt,
      credentialId,
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
function personalSecret(p: {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}): string {
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
 * The credential id most tests harvest under — tests that aren't specifically about cross-credential
 * scoping (the whole point of this module) use this as BOTH the harvested snapshot's tag AND the org's
 * selected credential, so `get()`'s harvest-trust gate passes and the pre-existing freshness/publish
 * assertions keep exercising the same behavior they always did.
 */
const CRED = 'cred-default';

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
    selectedCredentialId?: string | null;
  } = {},
): {
  svc: OauthUsageService;
  bus: UsageEventBus;
  published: UsageChange[];
  claudeStore: FakeClaudeStore;
} {
  const store = opts.store ?? new FakeCredentialStore();
  const claudeStore =
    opts.claudeStore ??
    new FakeClaudeStore([], opts.selectedDisplay ?? null, opts.selectedCredentialId ?? CRED);
  const bus = new UsageEventBus();
  const published: UsageChange[] = [];
  bus.stream$.subscribe((e) => published.push(e));
  const credRefresh = new FakeCredRefresh(claudeStore);
  const svc = new OauthUsageService(
    NO_ENGINE_AUTH as unknown as CredentialResolver,
    store as unknown as TenantCredentialStore,
    claudeStore as unknown as ClaudeCredentialStore,
    bus,
    credRefresh as unknown as CredentialRefreshService,
  );
  return { svc, bus, published, claudeStore };
}

describe('OauthUsageService.applyHarvest', () => {
  it('paints the session window full on a rejected frame that omits utilization + window', async () => {
    const { svc } = makeService();
    const resetsAt = Date.now() + 60 * 60 * 1000;
    await svc.applyHarvest('org1', {
      status: 'rejected',
      resetsAt,
      credentialId: CRED,
    });

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
      credentialId: CRED,
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
      credentialId: CRED,
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
      credentialId: CRED,
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
      credentialId: CRED,
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
      credentialId: CRED,
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
    const frame = {
      status: 'rejected' as const,
      rateLimitType: 'five_hour',
      resetsAt,
    };
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
      credentialId: CRED,
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
      {
        utilization: 100,
        resetsAt: new Date(Date.now() - 60_000).toISOString(),
      },
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
      {
        utilization: 100,
        resetsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      },
      Date.now(),
      CRED,
    );
    const usage = await svc.get('org1');
    expect(usage.fiveHour?.utilization).toBe(100);
  });
});

describe('OauthUsageService.getUtilization', () => {
  it('returns undefined for a rolled-over corroboration window', async () => {
    const store = new FakeCredentialStore();
    const { svc } = makeService({ store });
    await store.mergeClaudeUsageWindow(
      'org1',
      'fiveHour',
      {
        utilization: 100,
        resetsAt: new Date(Date.now() - 60_000).toISOString(),
      },
      Date.now(),
      CRED,
    );

    await expect(svc.getUtilization('org1', 'five_hour')).resolves.toBeUndefined();
  });

  it('returns undefined for an invalid corroboration reset timestamp', async () => {
    const store = new FakeCredentialStore();
    const { svc } = makeService({ store });
    await store.mergeClaudeUsageWindow(
      'org1',
      'fiveHour',
      { utilization: 100, resetsAt: 'not-a-date' },
      Date.now(),
      CRED,
    );

    await expect(svc.getUtilization('org1', 'five_hour')).resolves.toBeUndefined();
  });

  it('returns utilization for the unrolled binding window', async () => {
    const store = new FakeCredentialStore();
    const { svc } = makeService({ store });
    await store.mergeClaudeUsageWindow(
      'org1',
      'sevenDay',
      {
        utilization: 96,
        resetsAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      },
      Date.now(),
      CRED,
    );

    await expect(svc.getUtilization('org1', 'seven_day')).resolves.toBe(96);
  });
});

describe('OauthUsageService.get freshness (harvest vs live)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * A `makeService` variant whose `engineAuth` resolves a real `personal` credential (`cred1`), so
   * `get()`'s live path actually hits the stubbed `fetch` instead of degrading — these tests need a real
   * competing `live.fetchedAt` to exercise the freshness comparison.
   */
  function makeServiceWithLiveCredential(): {
    svc: OauthUsageService;
    store: FakeCredentialStore;
  } {
    const store = new FakeCredentialStore();
    const claudeStore = new FakeClaudeStore(
      [
        {
          id: 'cred1',
          kind: 'personal',
          secret: personalSecret({
            accessToken: 'at-personal',
            refreshToken: 'rt-personal',
            expiresAt: Date.now() + 60 * 60 * 1000,
          }),
        },
      ],
      null,
      'cred1', // selected — matches the harvested snapshot's credentialId so the trust gate passes
    );
    const bus = new UsageEventBus();
    const credRefresh = new FakeCredRefresh(claudeStore);
    // `secret` itself is never read on this path — `fetchLive` resolves the real secret through
    // `ensureFresh(orgId, refreshBack.credentialId)`, which the fake reads straight off `claudeStore`.
    const engineAuth: Pick<CredentialResolver, 'engineAuth'> = {
      engineAuth: () =>
        Promise.resolve({
          secret: '',
          kind: 'personal',
          refreshBack: {
            orgId: 'org1',
            engine: 'claude',
            credentialId: 'cred1',
          },
        }),
    };
    const svc = new OauthUsageService(
      engineAuth as unknown as CredentialResolver,
      store as unknown as TenantCredentialStore,
      claudeStore as unknown as ClaudeCredentialStore,
      bus,
      credRefresh as unknown as CredentialRefreshService,
    );
    return { svc, store };
  }

  it('idle open: live newer than harvest → serves live windows stamped ~now (usage_api)', async () => {
    const { svc, store } = makeServiceWithLiveCredential();
    const harvestResetsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await store.mergeClaudeUsageWindow(
      'org1',
      'fiveHour',
      { utilization: 99, resetsAt: harvestResetsAt },
      Date.now() - 60 * 60 * 1000,
      'cred1',
    );
    const liveResetsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => jsonResponse(200, usageBody(7, liveResetsAt))),
    );

    const usage = await svc.get('org1');

    expect(usage.fiveHour?.utilization).toBe(7);
    expect(usage.source).toBe('usage_api');
    expect(Date.now() - new Date(usage.fetchedAt).getTime()).toBeLessThan(5000);
  });

  it('mid-turn: just-harvested newer than live → serves harvest with harvest stamp (SSE real-time preserved)', async () => {
    const { svc, store } = makeServiceWithLiveCredential();
    const liveResetsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => jsonResponse(200, usageBody(7, liveResetsAt))),
    );
    const harvestResetsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    // Strictly >= the live fetch's own `fetchedAt` (also ~now) so the freshness comparison picks harvest.
    const harvestNow = Date.now() + 1000;
    await store.mergeClaudeUsageWindow(
      'org1',
      'fiveHour',
      { utilization: 88, resetsAt: harvestResetsAt },
      harvestNow,
      'cred1',
    );

    const usage = await svc.get('org1');

    expect(usage.fiveHour?.utilization).toBe(88);
    expect(usage.source).toBe('harvested');
    expect(new Date(usage.fetchedAt).getTime()).toBe(harvestNow);
  });
});

describe('OauthUsageService.get credential-scoped harvest trust', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * Like `makeServiceWithLiveCredential` above, but the org's SELECTED credential id is configurable
   * independently of the harvested snapshot's own tag — these tests are specifically about the
   * cross-credential trust gate (d2), not the harvest-vs-live freshness race.
   */
  function makeServiceForTrust(selectedCredentialId: string | null): {
    svc: OauthUsageService;
    store: FakeCredentialStore;
  } {
    const store = new FakeCredentialStore();
    const claudeStore = new FakeClaudeStore(
      [
        {
          id: 'cred-live',
          kind: 'personal',
          secret: personalSecret({
            accessToken: 'at-live',
            refreshToken: 'rt-live',
            expiresAt: Date.now() + 60 * 60 * 1000,
          }),
        },
      ],
      null,
      selectedCredentialId,
    );
    const bus = new UsageEventBus();
    const credRefresh = new FakeCredRefresh(claudeStore);
    // `fetchLive` resolves through the currently-SELECTED credential ('cred-live' in every test below).
    const engineAuth: Pick<CredentialResolver, 'engineAuth'> = {
      engineAuth: () =>
        Promise.resolve({
          secret: '',
          kind: 'personal',
          refreshBack: {
            orgId: 'org1',
            engine: 'claude',
            credentialId: 'cred-live',
          },
        }),
    };
    const svc = new OauthUsageService(
      engineAuth as unknown as CredentialResolver,
      store as unknown as TenantCredentialStore,
      claudeStore as unknown as ClaudeCredentialStore,
      bus,
      credRefresh as unknown as CredentialRefreshService,
    );
    return { svc, store };
  }

  it('a snapshot tagged to a DIFFERENT (deselected) credential is ignored — live wins', async () => {
    const { svc, store } = makeServiceForTrust('cred-live'); // selected = B
    await store.mergeClaudeUsageWindow(
      'org1',
      'fiveHour',
      {
        utilization: 100,
        resetsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
      Date.now(),
      'cred-old', // A — a different, now-deselected credential
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        jsonResponse(200, usageBody(21, new Date(Date.now() + 60 * 60 * 1000).toISOString())),
      ),
    );

    const usage = await svc.get('org1');

    expect(usage.fiveHour?.utilization).toBe(21);
    expect(usage.source).toBe('usage_api');
  });

  it('a snapshot tagged to the SELECTED credential is trusted — fresh harvest wins', async () => {
    const { svc, store } = makeServiceForTrust('cred-live');
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        jsonResponse(200, usageBody(21, new Date(Date.now() + 60 * 60 * 1000).toISOString())),
      ),
    );
    const harvestNow = Date.now() + 1000; // strictly newer than the live fetch's own `fetchedAt`
    await store.mergeClaudeUsageWindow(
      'org1',
      'fiveHour',
      {
        utilization: 100,
        resetsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
      harvestNow,
      'cred-live',
    );

    const usage = await svc.get('org1');

    expect(usage.fiveHour?.utilization).toBe(100);
    expect(usage.source).toBe('harvested');
  });

  it('a snapshot with no credentialId (legacy/reattach) is untrusted — live wins', async () => {
    const { svc, store } = makeServiceForTrust('cred-live');
    await store.mergeClaudeUsageWindow(
      'org1',
      'fiveHour',
      {
        utilization: 100,
        resetsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
      Date.now(),
      // no credentialId — legacy/untagged snapshot
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        jsonResponse(200, usageBody(21, new Date(Date.now() + 60 * 60 * 1000).toISOString())),
      ),
    );

    const usage = await svc.get('org1');

    expect(usage.fiveHour?.utilization).toBe(21);
    expect(usage.source).toBe('usage_api');
  });

  it('applyHarvest forwards its credentialId into mergeClaudeUsageWindow (tags the resulting snapshot)', async () => {
    const store = new FakeCredentialStore();
    const { svc } = makeService({
      store,
      selectedCredentialId: 'cred-forward',
    });
    await svc.applyHarvest('org1', {
      status: 'rejected',
      rateLimitType: 'five_hour',
      resetsAt: Date.now() + 60 * 60 * 1000,
      credentialId: 'cred-forward',
    });

    const snapshot = await store.readClaudeUsageSnapshot('org1');
    expect(snapshot?.credentialId).toBe('cred-forward');
    // Only trusted (selected === harvested) because the id was actually forwarded — proves the wiring.
    const usage = await svc.get('org1');
    expect(usage.fiveHour?.utilization).toBe(100);
    expect(usage.source).toBe('harvested');
  });
});

describe('parseModelWindows (usage API limits[] → per-model weekly rows)', () => {
  it('extracts a weekly_scoped model entry (Fable) with its 0-100 percent and null reset', () => {
    const root = {
      limits: [
        {
          kind: 'session',
          group: 'session',
          percent: 94,
          resets_at: '2026-07-11T10:10:00Z',
        },
        {
          kind: 'weekly_all',
          group: 'weekly',
          percent: 59,
          resets_at: '2026-07-12T09:00:00Z',
        },
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
          {
            kind: 'weekly_scoped',
            percent: 'x',
            scope: { model: { display_name: 'Bad' } },
          }, // percent not a number
          { kind: 'session', percent: 94 },
        ],
      }),
    ).toEqual([]);
  });

  it('clamps + rounds the model percent (already 0-100, not the SDK fraction)', () => {
    const root = {
      limits: [
        {
          kind: 'weekly_scoped',
          percent: 150.7,
          scope: { model: { display_name: 'A' } },
        },
        {
          kind: 'weekly_scoped',
          percent: 33.4,
          resets_at: '2026-07-12T09:00:00Z',
          scope: { model: { display_name: 'B' } },
        },
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
    expect(usage.fiveHour).toEqual({
      utilization: 42,
      resetsAt: new Date(resetsAt).toISOString(),
    });
    expect(claudeStore.advanceCalls).toHaveLength(0);
  });

  it('reports a fresh account (all fixed windows null, only a per-model row) as ok — not degraded', async () => {
    // A brand-new account has used nothing yet: the endpoint responds 200 with every fixed window absent
    // and (often) only a per-model weekly cap. That is a fresh, not-started account — NOT an outage — so it
    // must surface as ok:true/source:'usage_api' (which the UI reads as "Waiting for next turn" rather than
    // the "Usage unavailable" reserved for a real fetch failure).
    const resetsAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    const freshBody = {
      limits: [
        {
          kind: 'weekly_scoped',
          percent: 0,
          resets_at: resetsAt,
          scope: { model: { display_name: 'Fable' } },
        },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(() => jsonResponse(200, freshBody)),
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
    const { svc } = makeService({ claudeStore });

    const usage = await svc.getForCredential('org1', 'cred1');

    expect(usage.ok).toBe(true);
    expect(usage.source).toBe('usage_api');
    expect(usage.fiveHour).toBeNull();
    expect(usage.sevenDay).toBeNull();
    expect(usage.modelWindows).toEqual([{ label: 'Fable', utilization: 0, resetsAt }]);
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
