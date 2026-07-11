import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeUsageSnapshot, ClaudeUsageWindowKey, StoredUsageWindow } from '@workspace/shared';
import type { EnvService } from '@core/config/env/env.service';
import { OauthUsageService } from './oauth-usage.service';
import type { ClaudeCredentialStore, ClaudeCredentialSummary } from './claude-credential.store';
import type { CredentialResolver } from './credential-resolver.service';
import type { TenantCredentialStore } from './tenant-credential.store';

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
  ): Promise<void> {
    const snapshot = this.snapshots.get(orgId) ?? { windows: {}, fetchedAt: 0 };
    const existing = snapshot.windows[key];
    if (existing && existing.utilization === window.utilization && existing.resetsAt === window.resetsAt) {
      return Promise.resolve();
    }
    this.snapshots.set(orgId, {
      windows: { ...snapshot.windows, [key]: window },
      fetchedAt,
    });
    return Promise.resolve();
  }
}

type FakeCredentialRow = { id: string; kind: 'setup_token' | 'personal'; secret: string };

/**
 * Minimal in-memory stand-in for `ClaudeCredentialStore`'s per-credential read/write-back surface — just
 * enough for `getForCredential`'s routing + on-demand-refresh write-back to exercise against.
 */
class FakeClaudeStore {
  readonly advanceCalls: Array<{ orgId: string; credentialId: string; secret: string }> = [];

  constructor(private readonly rows: FakeCredentialRow[] = []) {}

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

/** applyHarvest writes through to the (fake) durable store; get() serves the harvested snapshot without HTTP when it's fresh. */
function makeService(
  store: FakeCredentialStore = new FakeCredentialStore(),
  claudeStore: FakeClaudeStore = new FakeClaudeStore(),
): OauthUsageService {
  // No credential is needed: a fresh, non-empty harvest short-circuits the HTTP fallback in get().
  return new OauthUsageService(
    {} as unknown as CredentialResolver,
    store as unknown as TenantCredentialStore,
    claudeStore as unknown as ClaudeCredentialStore,
    { get: () => undefined } as unknown as EnvService,
  );
}

describe('OauthUsageService.applyHarvest', () => {
  it('paints the session window full on a rejected frame that omits utilization + window', async () => {
    const svc = makeService();
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
    const svc = makeService();
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
    const svc = makeService();
    const seconds = 1783650000; // epoch seconds → 2026
    await svc.applyHarvest('org1', {
      status: 'rejected',
      rateLimitType: 'five_hour',
      resetsAt: seconds,
    });
    const usage = await svc.get('org1');
    expect(usage.fiveHour?.resetsAt).toBe(new Date(seconds * 1000).toISOString());
    expect(new Date(usage.fiveHour!.resetsAt).getUTCFullYear()).toBe(2026);
  });

  it('records a non-rejected frame at its reported utilization', async () => {
    const svc = makeService();
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
    const svc = makeService();
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
    const svc = makeService();
    await svc.applyHarvest('org1', { status: 'rejected', utilization: 100 });
    const usage = await svc.get('org1');
    expect(usage.ok).toBe(false);
  });

  it('durably writes through to the store and is readable by a fresh service instance', async () => {
    const store = new FakeCredentialStore();
    const svc = makeService(store);
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
    const freshSvc = makeService(store);
    const usage = await freshSvc.get('org1');
    expect(usage.sevenDayOpus).toEqual({
      utilization: 100,
      resetsAt: new Date(resetsAt).toISOString(),
    });
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
    const svc = makeService(new FakeCredentialStore(), claudeStore);

    const usage = await svc.getForCredential('org1', 'cred1');

    expect(usage.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('degrades an unknown credential id without hitting the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const svc = makeService(new FakeCredentialStore(), new FakeClaudeStore([]));

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
    const svc = makeService(new FakeCredentialStore(), claudeStore);

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
    const svc = makeService(store, claudeStore);

    const usage = await svc.getForCredential('org1', 'cred1');

    expect(usage.fiveHour?.utilization).toBe(7);
  });
});
