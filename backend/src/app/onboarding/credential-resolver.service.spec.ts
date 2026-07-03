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
    async read(orgId: string) {
      return rows[orgId] ?? null;
    },
  } as unknown as TenantCredentialStore;
}

describe('CredentialResolver — env-fallback contract', () => {
  describe('anthropicKey', () => {
    it('falls back to env when orgId is undefined', async () => {
      const r = new CredentialResolver(fakeStore({}), fakeEnv({ ANTHROPIC_API_KEY: 'env-key' }));
      expect(await r.anthropicKey(undefined)).toBe('env-key');
    });

    it('falls back to env when the team has no row', async () => {
      const r = new CredentialResolver(fakeStore({}), fakeEnv({ ANTHROPIC_API_KEY: 'env-key' }));
      expect(await r.anthropicKey('T1')).toBe('env-key');
    });

    it('falls back to env when the row has no anthropic key', async () => {
      const r = new CredentialResolver(
        fakeStore({ T1: {} }),
        fakeEnv({ ANTHROPIC_API_KEY: 'env-key' }),
      );
      expect(await r.anthropicKey('T1')).toBe('env-key');
    });

    it('returns the tenant key when present', async () => {
      const r = new CredentialResolver(
        fakeStore({ T1: { anthropicApiKey: 'tenant-key' } }),
        fakeEnv({ ANTHROPIC_API_KEY: 'env-key' }),
      );
      expect(await r.anthropicKey('T1')).toBe('tenant-key');
    });
  });

  describe('githubToken', () => {
    it('falls back to env GITHUB_TOKEN', async () => {
      const r = new CredentialResolver(fakeStore({}), fakeEnv({ GITHUB_TOKEN: 'b' }));
      expect(await r.githubToken(undefined)).toBe('b');
    });

    it('returns the tenant PAT when present', async () => {
      const r = new CredentialResolver(
        fakeStore({ T1: { githubPat: 'ghp_tenant' } }),
        fakeEnv({ GITHUB_TOKEN: 'env' }),
      );
      expect(await r.githubToken('T1')).toBe('ghp_tenant');
    });
  });

  describe('engineAuth (subscription-only, per-engine)', () => {
    it('env CLAUDE_OAUTH_TOKEN → claude subscription secret', async () => {
      const r = new CredentialResolver(fakeStore({}), fakeEnv({ CLAUDE_OAUTH_TOKEN: 'oauth' }));
      expect(await r.engineAuth(undefined, 'claude')).toEqual({ secret: 'oauth' });
    });

    it('env CODEX_OAUTH_TOKEN → codex subscription secret', async () => {
      const r = new CredentialResolver(fakeStore({}), fakeEnv({ CODEX_OAUTH_TOKEN: 'codex-oauth' }));
      expect(await r.engineAuth(undefined, 'codex')).toEqual({ secret: 'codex-oauth' });
    });

    it('returns undefined when neither per-org nor env secret is set (engine throws downstream)', async () => {
      const r = new CredentialResolver(fakeStore({}), fakeEnv({ ANTHROPIC_API_KEY: 'env-key' }));
      expect(await r.engineAuth(undefined, 'claude')).toBeUndefined();
    });

    it('tenant claude secret wins over env, carrying refreshBack provenance', async () => {
      const r = new CredentialResolver(
        fakeStore({ T1: { claudeOauthToken: 'tenant-oauth' } }),
        fakeEnv({ CLAUDE_OAUTH_TOKEN: 'env-oauth' }),
      );
      expect(await r.engineAuth('T1', 'claude')).toEqual({
        secret: 'tenant-oauth',
        refreshBack: { orgId: 'T1', engine: 'claude' },
      });
    });

    it('tenant codex secret is used for codex, carrying refreshBack provenance', async () => {
      const r = new CredentialResolver(
        fakeStore({ T1: { codexAuthSecret: 'tenant-codex' } }),
        fakeEnv({}),
      );
      expect(await r.engineAuth('T1', 'codex')).toEqual({
        secret: 'tenant-codex',
        refreshBack: { orgId: 'T1', engine: 'codex' },
      });
    });

    it('env-fallback auth carries NO refreshBack (nowhere to persist a refresh)', async () => {
      const r = new CredentialResolver(fakeStore({}), fakeEnv({ CODEX_OAUTH_TOKEN: 'env-codex' }));
      const auth = await r.engineAuth('T1', 'codex'); // org has no row → env fallback
      expect(auth).toEqual({ secret: 'env-codex' });
      expect(auth?.refreshBack).toBeUndefined();
    });

    it('is engine-specific: a tenant claude secret does not satisfy a codex request', async () => {
      const r = new CredentialResolver(
        fakeStore({ T1: { claudeOauthToken: 'tenant-oauth' } }),
        fakeEnv({ CODEX_OAUTH_TOKEN: 'env-codex' }),
      );
      expect(await r.engineAuth('T1', 'codex')).toEqual({ secret: 'env-codex' });
    });

    it('partial tenant row (no secret for this engine) → env fallback', async () => {
      const r = new CredentialResolver(
        fakeStore({ T1: {} }),
        fakeEnv({ CLAUDE_OAUTH_TOKEN: 'env-oauth' }),
      );
      expect(await r.engineAuth('T1', 'claude')).toEqual({ secret: 'env-oauth' });
    });
  });
});
