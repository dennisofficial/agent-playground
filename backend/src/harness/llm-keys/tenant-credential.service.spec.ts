import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EWorkerEngineName } from '../engines/worker-engine.port';
import type { LlmProvider, ProviderCredential } from './llm-key.types';
import type { ProviderKeyStore } from './provider-key.store';
import { TenantCredentialService } from './tenant-credential.service';

/** A ProviderKeyStore double driven by an in-memory per-provider credential map. */
function fakeStore(
  creds: Partial<Record<LlmProvider, ProviderCredential>>,
): ProviderKeyStore {
  return {
    resolveCredential: (_team: string, provider: LlmProvider) =>
      Promise.resolve(creds[provider]),
  } as unknown as ProviderKeyStore;
}

describe('TenantCredentialService.engineAuth', () => {
  const TEAM = 'team-1';
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    // Isolate from the dev env fallback so api-key resolution is deterministic.
    saved = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('Claude turn → anthropic api_key by default', async () => {
    const svc = new TenantCredentialService(
      fakeStore({ anthropic: { apiKey: 'sk-ant', engineAuthMode: 'api_key' } }),
    );
    expect(await svc.engineAuth(TEAM, EWorkerEngineName.CLAUDE)).toEqual({
      mode: 'api_key',
      apiKey: 'sk-ant',
    });
  });

  it('Claude turn → subscription when anthropic mode=subscription with a secret', async () => {
    const svc = new TenantCredentialService(
      fakeStore({
        anthropic: {
          apiKey: 'sk-ant',
          engineAuthMode: 'subscription',
          subscriptionSecret: 'oauth-tok',
        },
      }),
    );
    expect(await svc.engineAuth(TEAM, EWorkerEngineName.CLAUDE)).toEqual({
      mode: 'subscription',
      secret: 'oauth-tok',
    });
  });

  it('Codex turn → the openai provider (not anthropic)', async () => {
    const svc = new TenantCredentialService(
      fakeStore({
        openai: {
          apiKey: 'sk-oai',
          engineAuthMode: 'subscription',
          subscriptionSecret: 'auth-json',
        },
        anthropic: {
          apiKey: 'sk-ant',
          engineAuthMode: 'subscription',
          subscriptionSecret: 'oauth-tok',
        },
      }),
    );
    expect(await svc.engineAuth(TEAM, EWorkerEngineName.CODEX)).toEqual({
      mode: 'subscription',
      secret: 'auth-json',
    });
  });

  it('degrades to api_key when subscription mode is set but NO secret stored', async () => {
    const svc = new TenantCredentialService(
      fakeStore({
        anthropic: { apiKey: 'sk-ant', engineAuthMode: 'subscription' },
      }),
    );
    expect(await svc.engineAuth(TEAM, EWorkerEngineName.CLAUDE)).toEqual({
      mode: 'api_key',
      apiKey: 'sk-ant',
    });
  });

  it('resolve() still returns the API-key map unchanged (chat/embeddings path)', async () => {
    const svc = new TenantCredentialService(
      fakeStore({
        anthropic: {
          apiKey: 'sk-ant',
          engineAuthMode: 'subscription',
          subscriptionSecret: 'oauth-tok',
        },
        openai: { apiKey: 'sk-oai', engineAuthMode: 'api_key' },
      }),
    );
    expect(await svc.resolve(TEAM)).toEqual({
      anthropic: 'sk-ant',
      openai: 'sk-oai',
    });
  });
});
