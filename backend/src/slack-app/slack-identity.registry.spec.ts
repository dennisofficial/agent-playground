import type { SlackIdentityStore } from '@harness/slack-identities/slack-identity.store';
import { SlackIdentityRegistry } from './slack-identity.registry';

const fakeStore = (tokens: Record<string, string | Error | undefined>) =>
  ({
    resolve: vi.fn(async (_teamId: string, botId: string) => {
      const v = tokens[botId];
      if (v instanceof Error) throw v;
      return v;
    }),
  }) as unknown as SlackIdentityStore;

describe('SlackIdentityRegistry', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('builds a WebClient on hit and caches it (one resolve per TTL window)', async () => {
    const store = fakeStore({ alex: 'xoxb-alex' });
    const registry = new SlackIdentityRegistry(store);
    const first = await registry.clientFor('T1', 'alex');
    expect(first).toBeDefined();
    expect(await registry.clientFor('T1', 'alex')).toBe(first);
    expect(store.resolve).toHaveBeenCalledTimes(1);
  });

  it('re-resolves a hit after its TTL — token rotation lands without a restart', async () => {
    const tokens: Record<string, string> = { alex: 'xoxb-old' };
    const store = fakeStore(tokens);
    const registry = new SlackIdentityRegistry(store);
    const old = await registry.clientFor('T1', 'alex');
    tokens.alex = 'xoxb-rotated';
    vi.advanceTimersByTime(10 * 60_000 + 1);
    const fresh = await registry.clientFor('T1', 'alex');
    expect(fresh).toBeDefined();
    expect(fresh).not.toBe(old);
    expect(store.resolve).toHaveBeenCalledTimes(2);
  });

  it('caches a miss briefly, then re-checks — a fresh PUT lights the puppet up', async () => {
    const tokens: Record<string, string | undefined> = { alex: undefined };
    const store = fakeStore(tokens);
    const registry = new SlackIdentityRegistry(store);
    expect(await registry.clientFor('T1', 'alex')).toBeUndefined();
    expect(await registry.clientFor('T1', 'alex')).toBeUndefined(); // within miss TTL — no re-query
    expect(store.resolve).toHaveBeenCalledTimes(1);

    tokens.alex = 'xoxb-new';
    vi.advanceTimersByTime(60_000 + 1);
    expect(await registry.clientFor('T1', 'alex')).toBeDefined();
  });

  it('degrades resolve failures (cipher unset) to undefined and retries later', async () => {
    const store = fakeStore({ alex: new Error('SECRETS_ENCRYPTION_KEY is not set') });
    const registry = new SlackIdentityRegistry(store);
    await expect(registry.clientFor('T1', 'alex')).resolves.toBeUndefined();
    vi.advanceTimersByTime(60_000 + 1);
    await expect(registry.clientFor('T1', 'alex')).resolves.toBeUndefined();
    expect(store.resolve).toHaveBeenCalledTimes(2);
  });
});
