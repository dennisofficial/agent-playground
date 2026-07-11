import { describe, expect, it } from 'vitest';
import type { ClaudeUsageSnapshot, ClaudeUsageWindowKey, StoredUsageWindow } from '@workspace/shared';
import { OauthUsageService } from './oauth-usage.service';
import type { CredentialResolver } from './credential-resolver.service';
import type { TenantCredentialStore } from './tenant-credential.store';
import { UsageEventBus, type UsageChange } from './usage-event-bus';

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

/**
 * applyHarvest writes through to the (fake) durable store; get() serves the harvested snapshot without HTTP
 * when it's fresh. Also returns the service's `UsageEventBus` (and a running list of everything it published)
 * so tests can assert on realtime fan-out.
 */
function makeService(
  store: FakeCredentialStore = new FakeCredentialStore(),
): { svc: OauthUsageService; bus: UsageEventBus; published: UsageChange[] } {
  const bus = new UsageEventBus();
  const published: UsageChange[] = [];
  bus.stream$.subscribe((e) => published.push(e));
  const svc = new OauthUsageService(
    NO_ENGINE_AUTH as unknown as CredentialResolver,
    store as unknown as TenantCredentialStore,
    bus,
  );
  return { svc, bus, published };
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
    const { svc } = makeService(store);
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
    const { svc: freshSvc } = makeService(store);
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
    const { svc } = makeService(store);
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
    const { svc, published } = makeService(store);
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
