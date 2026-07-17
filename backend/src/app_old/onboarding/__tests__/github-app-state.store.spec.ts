import type Redis from 'ioredis';
import { describe, expect, it } from 'vitest';
import { GithubAppStateStore } from '../github-app-state.store';

class FakeRedis {
  private readonly data = new Map<string, string>();

  set(key: string, value: string): Promise<'OK'> {
    this.data.set(key, value);
    return Promise.resolve('OK');
  }

  eval(_script: string, _keyCount: number, key: string): Promise<string | null> {
    const value = this.data.get(key) ?? null;
    this.data.delete(key);
    return Promise.resolve(value);
  }
}

function makeStore(): { store: GithubAppStateStore; redis: FakeRedis } {
  const redis = new FakeRedis();
  return { store: new GithubAppStateStore(redis as unknown as Redis), redis };
}

describe('GithubAppStateStore', () => {
  it('stash then consume round-trips the orgId + userId', async () => {
    const { store } = makeStore();
    const nonce = await store.stash('org1', 'user1');
    await expect(store.consume(nonce)).resolves.toEqual({
      orgId: 'org1',
      userId: 'user1',
    });
  });

  it('consume is single-use — a second consume of the same nonce returns null', async () => {
    const { store } = makeStore();
    const nonce = await store.stash('org1', 'user1');
    await store.consume(nonce);
    await expect(store.consume(nonce)).resolves.toBeNull();
  });

  it('consuming an unknown nonce returns null', async () => {
    const { store } = makeStore();
    await expect(store.consume('never-stashed')).resolves.toBeNull();
  });

  it('a legacy nonce holding a bare orgId string degrades to userId: null', async () => {
    const { store, redis } = makeStore();
    await redis.set('github_app_state:legacy-nonce', 'org1');
    await expect(store.consume('legacy-nonce')).resolves.toEqual({
      orgId: 'org1',
      userId: null,
    });
  });

  it('mints a distinct random nonce on every stash', async () => {
    const { store } = makeStore();
    const a = await store.stash('org1', 'user1');
    const b = await store.stash('org1', 'user1');
    expect(a).not.toBe(b);
  });
});
