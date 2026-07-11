import { describe, expect, it } from 'vitest';
import type Redis from 'ioredis';
import { GithubAppStateStore } from './github-app-state.store';

/** Map-backed fake standing in for the `ioredis` calls the store makes: `set(k,v,'EX',ttl)` / `get` / `del`. */
class FakeRedis {
  private readonly data = new Map<string, string>();

  set(key: string, value: string): Promise<'OK'> {
    this.data.set(key, value);
    return Promise.resolve('OK');
  }

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.data.get(key) ?? null);
  }

  del(key: string): Promise<number> {
    return Promise.resolve(this.data.delete(key) ? 1 : 0);
  }
}

function makeStore(): { store: GithubAppStateStore; redis: FakeRedis } {
  const redis = new FakeRedis();
  return { store: new GithubAppStateStore(redis as unknown as Redis), redis };
}

describe('GithubAppStateStore', () => {
  it('stash then consume round-trips the orgId', async () => {
    const { store } = makeStore();
    const nonce = await store.stash('org1');
    await expect(store.consume(nonce)).resolves.toBe('org1');
  });

  it('consume is single-use — a second consume of the same nonce returns null', async () => {
    const { store } = makeStore();
    const nonce = await store.stash('org1');
    await store.consume(nonce);
    await expect(store.consume(nonce)).resolves.toBeNull();
  });

  it('consuming an unknown nonce returns null', async () => {
    const { store } = makeStore();
    await expect(store.consume('never-stashed')).resolves.toBeNull();
  });

  it('mints a distinct random nonce on every stash', async () => {
    const { store } = makeStore();
    const a = await store.stash('org1');
    const b = await store.stash('org1');
    expect(a).not.toBe(b);
  });
});
