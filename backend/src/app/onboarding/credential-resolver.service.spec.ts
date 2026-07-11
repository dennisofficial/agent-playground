import { describe, expect, it } from 'vitest';
import type { ClaudeCredentialStore } from './claude-credential.store';
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

/** A claude store stubbed to return one org's SELECTED decrypted credential (or null). */
function fakeClaudeStore(
  rows: Record<string, { id: string; kind: 'setup_token' | 'personal'; secret: string } | null>,
): ClaudeCredentialStore {
  return {
    async getSelectedDecrypted(orgId: string) {
      return rows[orgId] ?? null;
    },
  } as unknown as ClaudeCredentialStore;
}

describe('CredentialResolver — per-org rows, no env fallback', () => {
  describe('anthropicKey / openaiKey / githubToken', () => {
    it('returns undefined when orgId is missing', async () => {
      const r = new CredentialResolver(fakeStore({}), fakeClaudeStore({}));
      expect(await r.anthropicKey(undefined)).toBeUndefined();
      expect(await r.openaiKey(undefined)).toBeUndefined();
      expect(await r.githubToken(undefined)).toBeUndefined();
    });

    it('returns undefined when the org has no row', async () => {
      const r = new CredentialResolver(fakeStore({}), fakeClaudeStore({}));
      expect(await r.anthropicKey('T1')).toBeUndefined();
      expect(await r.githubToken('T1')).toBeUndefined();
    });

    it('returns undefined when the row lacks that credential', async () => {
      const r = new CredentialResolver(fakeStore({ T1: {} }), fakeClaudeStore({}));
      expect(await r.anthropicKey('T1')).toBeUndefined();
    });

    it('returns the org value when present', async () => {
      const r = new CredentialResolver(
        fakeStore({
          T1: { anthropicApiKey: 'a', openaiApiKey: 'o', githubPat: 'ghp_x' },
        }),
        fakeClaudeStore({}),
      );
      expect(await r.anthropicKey('T1')).toBe('a');
      expect(await r.openaiKey('T1')).toBe('o');
      expect(await r.githubToken('T1')).toBe('ghp_x');
    });
  });

  describe('engineAuth (subscription-only, per-engine)', () => {
    it('returns undefined when orgId is missing', async () => {
      const r = new CredentialResolver(fakeStore({}), fakeClaudeStore({}));
      expect(await r.engineAuth(undefined, 'claude')).toBeUndefined();
      expect(await r.engineAuth(undefined, 'codex')).toBeUndefined();
    });

    it('claude: returns undefined when no credential is selected (no legacy fallback)', async () => {
      const r = new CredentialResolver(fakeStore({ T1: { claudeOauthToken: 'legacy' } }), fakeClaudeStore({ T1: null }));
      expect(await r.engineAuth('T1', 'claude')).toBeUndefined();
    });

    it('claude: returns the selected PERSONAL credential with kind + credentialId', async () => {
      const r = new CredentialResolver(
        fakeStore({}),
        fakeClaudeStore({ T1: { id: 'cred-1', kind: 'personal', secret: 'oauth-json' } }),
      );
      expect(await r.engineAuth('T1', 'claude')).toEqual({
        secret: 'oauth-json',
        kind: 'personal',
        refreshBack: { orgId: 'T1', engine: 'claude', credentialId: 'cred-1' },
      });
    });

    it('claude: returns the selected SETUP-TOKEN credential with kind + credentialId', async () => {
      const r = new CredentialResolver(
        fakeStore({}),
        fakeClaudeStore({ T1: { id: 'cred-2', kind: 'setup_token', secret: 'sk-token' } }),
      );
      expect(await r.engineAuth('T1', 'claude')).toEqual({
        secret: 'sk-token',
        kind: 'setup-token',
        refreshBack: { orgId: 'T1', engine: 'claude', credentialId: 'cred-2' },
      });
    });

    it('codex: returns undefined when the org has no secret for that engine (engine throws downstream)', async () => {
      const r = new CredentialResolver(fakeStore({ T1: {} }), fakeClaudeStore({}));
      expect(await r.engineAuth('T1', 'codex')).toBeUndefined();
    });

    it('codex: returns the org codex secret with refreshBack provenance', async () => {
      const r = new CredentialResolver(fakeStore({ T1: { codexAuthSecret: 'codex' } }), fakeClaudeStore({}));
      expect(await r.engineAuth('T1', 'codex')).toEqual({
        secret: 'codex',
        refreshBack: { orgId: 'T1', engine: 'codex' },
      });
    });

    it('is engine-specific: a selected claude credential does not satisfy a codex request', async () => {
      const r = new CredentialResolver(
        fakeStore({}),
        fakeClaudeStore({ T1: { id: 'cred-1', kind: 'personal', secret: 'oauth-json' } }),
      );
      expect(await r.engineAuth('T1', 'codex')).toBeUndefined();
    });
  });
});
