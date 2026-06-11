import type { LlmProvider } from './llm-key.types';
import { LlmReadinessService } from './llm-readiness.service';
import type { ProviderKeyStore } from './provider-key.store';

const fakeStore = (keys: Partial<Record<LlmProvider, string | Error>>) =>
  ({
    resolve: vi.fn(async (provider: LlmProvider) => {
      const v = keys[provider];
      if (v instanceof Error) throw v;
      return v;
    }),
  }) as unknown as ProviderKeyStore;

describe('LlmReadinessService', () => {
  const ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] as const;
  let saved: Record<string, string | undefined>;
  let service: LlmReadinessService | undefined;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    service?.onApplicationShutdown(); // clear the pending poll
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('is ready at boot when both env keys are present (store untouched)', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
    process.env.OPENAI_API_KEY = 'sk-env';
    const store = fakeStore({});
    service = new LlmReadinessService(store);
    await service.onModuleInit();
    expect(service.isReady).toBe(true);
    expect(store.resolve).not.toHaveBeenCalled();
  });

  it('resolves stored keys into process.env when env is empty', async () => {
    service = new LlmReadinessService(
      fakeStore({ anthropic: 'sk-ant-stored', openai: 'sk-stored' }),
    );
    await service.onModuleInit();
    expect(service.isReady).toBe(true);
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-stored');
    expect(process.env.OPENAI_API_KEY).toBe('sk-stored');
  });

  it('mixes sources — env wins per provider, the store fills only the gaps', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
    const store = fakeStore({ anthropic: 'sk-ant-stored', openai: 'sk-stored' });
    service = new LlmReadinessService(store);
    await service.onModuleInit();
    expect(service.isReady).toBe(true);
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-env'); // never overwritten
    expect(process.env.OPENAI_API_KEY).toBe('sk-stored');
    expect(store.resolve).toHaveBeenCalledTimes(1);
    expect(store.resolve).toHaveBeenCalledWith('openai');
  });

  it('stays pending while any provider is missing, and sets NO partial env', async () => {
    service = new LlmReadinessService(fakeStore({ anthropic: 'sk-ant-stored' }));
    await service.onModuleInit();
    expect(service.isReady).toBe(false);
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined(); // no partial key sets
  });

  it('fires ready$ exactly once, on the pending→ready edge', async () => {
    const keys: Partial<Record<LlmProvider, string>> = {};
    service = new LlmReadinessService(fakeStore(keys));
    const edges: number[] = [];
    service.ready$.subscribe(() => edges.push(1));
    await service.onModuleInit();
    expect(service.isReady).toBe(false);

    keys.anthropic = 'sk-ant-stored';
    expect(await service.refresh()).toBe(false);
    keys.openai = 'sk-stored';
    expect(await service.refresh()).toBe(true);
    expect(await service.refresh()).toBe(true); // idempotent — no second edge
    expect(edges).toHaveLength(1);
  });

  it('stays pending (no throw) when resolve fails — e.g. cipher key unset', async () => {
    service = new LlmReadinessService(
      fakeStore({ anthropic: new Error('SECRETS_ENCRYPTION_KEY is not set'), openai: 'sk' }),
    );
    await service.onModuleInit();
    expect(service.isReady).toBe(false);
  });
});
