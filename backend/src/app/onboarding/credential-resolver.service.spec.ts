import { describe, expect, it } from 'vitest';
import { CredentialResolver } from './credential-resolver.service';
import type { TenantCredentials, TenantCredentialStore } from './tenant-credential.store';

/** A store stubbed to return one org's creds (or null for any other / no row). */
function fakeStore(rows: Record<string, TenantCredentials | null>): TenantCredentialStore {
  return {
    async read(orgId: string) {
      return rows[orgId] ?? null;
    },
  } as unknown as TenantCredentialStore;
}

describe('CredentialResolver — per-org rows, no env fallback', () => {
  describe('anthropicKey / openaiKey / githubToken', () => {
    it('returns undefined when orgId is missing', async () => {
      const r = new CredentialResolver(fakeStore({}));
      expect(await r.anthropicKey(undefined)).toBeUndefined();
      expect(await r.openaiKey(undefined)).toBeUndefined();
      expect(await r.githubToken(undefined)).toBeUndefined();
    });

    it('returns undefined when the org has no row', async () => {
      const r = new CredentialResolver(fakeStore({}));
      expect(await r.anthropicKey('T1')).toBeUndefined();
      expect(await r.githubToken('T1')).toBeUndefined();
    });

    it('returns undefined when the row lacks that credential', async () => {
      const r = new CredentialResolver(fakeStore({ T1: {} }));
      expect(await r.anthropicKey('T1')).toBeUndefined();
    });

    it('returns the org value when present', async () => {
      const r = new CredentialResolver(
        fakeStore({
          T1: { anthropicApiKey: 'a', openaiApiKey: 'o', githubPat: 'ghp_x' },
        }),
      );
      expect(await r.anthropicKey('T1')).toBe('a');
      expect(await r.openaiKey('T1')).toBe('o');
      expect(await r.githubToken('T1')).toBe('ghp_x');
    });
  });

  describe('engineAuth (subscription-only, per-engine)', () => {
    it('returns undefined when orgId is missing', async () => {
      const r = new CredentialResolver(fakeStore({}));
      expect(await r.engineAuth(undefined, 'claude')).toBeUndefined();
      expect(await r.engineAuth(undefined, 'codex')).toBeUndefined();
    });

    it('returns undefined when the org has no secret for that engine (engine throws downstream)', async () => {
      const r = new CredentialResolver(fakeStore({ T1: {} }));
      expect(await r.engineAuth('T1', 'claude')).toBeUndefined();
      expect(await r.engineAuth('T1', 'codex')).toBeUndefined();
    });

    it('returns the org claude secret with refreshBack provenance', async () => {
      const r = new CredentialResolver(fakeStore({ T1: { claudeOauthToken: 'oauth' } }));
      expect(await r.engineAuth('T1', 'claude')).toEqual({
        secret: 'oauth',
        refreshBack: { orgId: 'T1', engine: 'claude' },
      });
    });

    it('returns the org codex secret with refreshBack provenance', async () => {
      const r = new CredentialResolver(fakeStore({ T1: { codexAuthSecret: 'codex' } }));
      expect(await r.engineAuth('T1', 'codex')).toEqual({
        secret: 'codex',
        refreshBack: { orgId: 'T1', engine: 'codex' },
      });
    });

    it('is engine-specific: a claude secret does not satisfy a codex request', async () => {
      const r = new CredentialResolver(fakeStore({ T1: { claudeOauthToken: 'oauth' } }));
      expect(await r.engineAuth('T1', 'codex')).toBeUndefined();
    });
  });
});
