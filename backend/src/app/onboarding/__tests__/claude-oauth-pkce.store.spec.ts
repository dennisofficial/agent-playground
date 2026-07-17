import { describe, expect, it } from 'vitest';
import type Redis from 'ioredis';
import { ClaudeOAuthPkceStore } from '../claude-oauth-pkce.store';

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

function makeStore(): { store: ClaudeOAuthPkceStore; redis: FakeRedis } {
  const redis = new FakeRedis();
  return { store: new ClaudeOAuthPkceStore(redis as unknown as Redis), redis };
}

describe('ClaudeOAuthPkceStore', () => {
  it('stash then consume returns the stashed verifier', async () => {
    const { store } = makeStore();
    await store.stash('org1', 'state1', 'verifier1');
    await expect(store.consume('org1', 'state1')).resolves.toBe('verifier1');
  });

  it('consume is single-use — a second consume of the same state returns null', async () => {
    const { store } = makeStore();
    await store.stash('org1', 'state1', 'verifier1');
    await store.consume('org1', 'state1');
    await expect(store.consume('org1', 'state1')).resolves.toBeNull();
  });

  it('consuming an unknown state returns null', async () => {
    const { store } = makeStore();
    await expect(store.consume('org1', 'never-stashed')).resolves.toBeNull();
  });

  it('scopes stashed verifiers by orgId — same state under a different org does not collide', async () => {
    const { store } = makeStore();
    await store.stash('org1', 'state1', 'verifier-org1');
    await expect(store.consume('org2', 'state1')).resolves.toBeNull();
    await expect(store.consume('org1', 'state1')).resolves.toBe(
      'verifier-org1',
    );
  });
});
