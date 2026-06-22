import { describe, expect, it } from 'vitest';
import type { EnvService } from '@core/config/env/env.service';
import { CredentialResolver } from './credential-resolver.service';
import type { TenantCredentials, TenantCredentialStore } from './tenant-credential.store';

function fakeEnv(map: Record<string, string | undefined> = {}): EnvService {
  return { get: (k: string) => map[k] } as unknown as EnvService;
}

/** A store stubbed to return one team's creds (or null for any other / no row). */
function fakeStore(rows: Record<string, TenantCredentials | null>): TenantCredentialStore {
  return {
    async read(teamId: string) {
      return rows[teamId] ?? null;
    },
  } as unknown as TenantCredentialStore;
}

describe('CredentialResolver — env-fallback contract', () => {
  describe('anthropicKey', () => {
    it('falls back to env when teamId is undefined', async () => {
      const r = new CredentialResolver(fakeStore({}), fakeEnv({ ANTHROPIC_API_KEY: 'env-key' }));
      expect(await r.anthropicKey(undefined)).toBe('env-key');
    });

    it('falls back to env when the team has no row', async () => {
      const r = new CredentialResolver(fakeStore({}), fakeEnv({ ANTHROPIC_API_KEY: 'env-key' }));
      expect(await r.anthropicKey('T1')).toBe('env-key');
    });

    it('falls back to env when the row has no anthropic key', async () => {
      const r = new CredentialResolver(
        fakeStore({ T1: { engineAuthMode: 'api_key' } }),
        fakeEnv({ ANTHROPIC_API_KEY: 'env-key' }),
      );
      expect(await r.anthropicKey('T1')).toBe('env-key');
    });

    it('returns the tenant key when present', async () => {
      const r = new CredentialResolver(
        fakeStore({ T1: { anthropicApiKey: 'tenant-key', engineAuthMode: 'api_key' } }),
        fakeEnv({ ANTHROPIC_API_KEY: 'env-key' }),
      );
      expect(await r.anthropicKey('T1')).toBe('tenant-key');
    });
  });

  describe('githubToken', () => {
    it('falls back env ATLAS_GITHUB_TOKEN then GITHUB_TOKEN', async () => {
      const r1 = new CredentialResolver(fakeStore({}), fakeEnv({ ATLAS_GITHUB_TOKEN: 'a', GITHUB_TOKEN: 'b' }));
      expect(await r1.githubToken(undefined)).toBe('a');
      const r2 = new CredentialResolver(fakeStore({}), fakeEnv({ GITHUB_TOKEN: 'b' }));
      expect(await r2.githubToken(undefined)).toBe('b');
    });

    it('returns the tenant PAT when present', async () => {
      const r = new CredentialResolver(
        fakeStore({ T1: { githubPat: 'ghp_tenant', engineAuthMode: 'api_key' } }),
        fakeEnv({ ATLAS_GITHUB_TOKEN: 'env' }),
      );
      expect(await r.githubToken('T1')).toBe('ghp_tenant');
    });
  });

  describe('engineAuth', () => {
    it('env default → api_key with ANTHROPIC_API_KEY', async () => {
      const r = new CredentialResolver(fakeStore({}), fakeEnv({ ANTHROPIC_API_KEY: 'env-key' }));
      expect(await r.engineAuth(undefined, 'claude')).toEqual({ mode: 'api_key', apiKey: 'env-key' });
    });

    it('env subscription → subscription secret for claude', async () => {
      const r = new CredentialResolver(
        fakeStore({}),
        fakeEnv({ ATLAS_ENGINE_AUTH_MODE: 'subscription', ATLAS_CLAUDE_OAUTH_TOKEN: 'oauth' }),
      );
      expect(await r.engineAuth(undefined, 'claude')).toEqual({ mode: 'subscription', secret: 'oauth' });
    });

    it('env subscription but no token → falls back to api_key', async () => {
      const r = new CredentialResolver(
        fakeStore({}),
        fakeEnv({ ATLAS_ENGINE_AUTH_MODE: 'subscription', ANTHROPIC_API_KEY: 'env-key' }),
      );
      expect(await r.engineAuth(undefined, 'claude')).toEqual({ mode: 'api_key', apiKey: 'env-key' });
    });

    it('tenant subscription posture wins', async () => {
      const r = new CredentialResolver(
        fakeStore({ T1: { engineAuthMode: 'subscription', engineAuthSecret: 'tenant-oauth' } }),
        fakeEnv({ ANTHROPIC_API_KEY: 'env-key' }),
      );
      expect(await r.engineAuth('T1', 'claude')).toEqual({ mode: 'subscription', secret: 'tenant-oauth' });
    });

    it('tenant api_key posture uses the tenant key', async () => {
      const r = new CredentialResolver(
        fakeStore({ T1: { engineAuthMode: 'api_key', anthropicApiKey: 'tenant-key' } }),
        fakeEnv({ ANTHROPIC_API_KEY: 'env-key' }),
      );
      expect(await r.engineAuth('T1', 'claude')).toEqual({ mode: 'api_key', apiKey: 'tenant-key' });
    });

    it('partial tenant row (api_key, no key) → env fallback', async () => {
      const r = new CredentialResolver(
        fakeStore({ T1: { engineAuthMode: 'api_key' } }),
        fakeEnv({ ANTHROPIC_API_KEY: 'env-key' }),
      );
      expect(await r.engineAuth('T1', 'claude')).toEqual({ mode: 'api_key', apiKey: 'env-key' });
    });
  });
});
