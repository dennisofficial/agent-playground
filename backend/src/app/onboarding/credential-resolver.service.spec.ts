import { describe, expect, it } from 'vitest';
import type { ClaudeCredentialStore } from './claude-credential.store';
import { CredentialResolver } from './credential-resolver.service';
import type { GitHubAppTokenService } from '../git/github-app-token.service';
import type {
  TenantCredentials,
  TenantCredentialStore,
} from './tenant-credential.store';

/** A store stubbed to return one org's creds (or null for any other / no row). */
function fakeStore(
  rows: Record<string, TenantCredentials | null>,
): TenantCredentialStore {
  return {
    read: (orgId: string) => Promise.resolve(rows[orgId] ?? null),
  } as unknown as TenantCredentialStore;
}

/** A claude store stubbed to return one org's SELECTED decrypted credential (or null). */
function fakeClaudeStore(
  rows: Record<
    string,
    { id: string; kind: 'setup_token' | 'personal'; secret: string } | null
  >,
): ClaudeCredentialStore {
  return {
    getSelectedDecrypted: (orgId: string) =>
      Promise.resolve(rows[orgId] ?? null),
  } as unknown as ClaudeCredentialStore;
}

/** A GitHub App token service stubbed to mint a fixed token / bot identity, or override to throw. */
function fakeAppTokens(
  overrides: {
    getInstallationToken?: (installationId: string) => Promise<string>;
    appBotIdentity?: () => Promise<{ name: string; email: string }>;
  } = {},
): GitHubAppTokenService {
  return {
    getInstallationToken:
      overrides.getInstallationToken ?? (() => Promise.resolve('ghs_minted')),
    appBotIdentity:
      overrides.appBotIdentity ??
      (() => Promise.resolve({ name: 'x[bot]', email: 'x' })),
  } as unknown as GitHubAppTokenService;
}

describe('CredentialResolver — per-org rows, no env fallback', () => {
  describe('anthropicKey / openaiKey / githubToken', () => {
    it('returns undefined when orgId is missing', async () => {
      const r = new CredentialResolver(
        fakeStore({}),
        fakeClaudeStore({}),
        fakeAppTokens(),
      );
      expect(await r.anthropicKey(undefined)).toBeUndefined();
      expect(await r.openaiKey(undefined)).toBeUndefined();
      expect(await r.githubToken(undefined)).toBeUndefined();
    });

    it('returns undefined when the org has no row', async () => {
      const r = new CredentialResolver(
        fakeStore({}),
        fakeClaudeStore({}),
        fakeAppTokens(),
      );
      expect(await r.anthropicKey('T1')).toBeUndefined();
      expect(await r.githubToken('T1')).toBeUndefined();
    });

    it('returns undefined when the row lacks that credential', async () => {
      const r = new CredentialResolver(
        fakeStore({ T1: {} }),
        fakeClaudeStore({}),
        fakeAppTokens(),
      );
      expect(await r.anthropicKey('T1')).toBeUndefined();
    });

    it('returns the org value when present', async () => {
      const r = new CredentialResolver(
        fakeStore({
          T1: { anthropicApiKey: 'a', openaiApiKey: 'o', githubPat: 'ghp_x' },
        }),
        fakeClaudeStore({}),
        fakeAppTokens(),
      );
      expect(await r.anthropicKey('T1')).toBe('a');
      expect(await r.openaiKey('T1')).toBe('o');
      expect(await r.githubToken('T1')).toBe('ghp_x');
    });
  });

  describe('engineAuth (subscription-only, per-engine)', () => {
    it('returns undefined when orgId is missing', async () => {
      const r = new CredentialResolver(
        fakeStore({}),
        fakeClaudeStore({}),
        fakeAppTokens(),
      );
      expect(await r.engineAuth(undefined, 'claude')).toBeUndefined();
      expect(await r.engineAuth(undefined, 'codex')).toBeUndefined();
    });

    it('claude: returns undefined when no credential is selected (no legacy fallback)', async () => {
      const r = new CredentialResolver(
        fakeStore({ T1: { claudeOauthToken: 'legacy' } }),
        fakeClaudeStore({ T1: null }),
        fakeAppTokens(),
      );
      expect(await r.engineAuth('T1', 'claude')).toBeUndefined();
    });

    it('claude: returns the selected PERSONAL credential with kind + credentialId', async () => {
      const r = new CredentialResolver(
        fakeStore({}),
        fakeClaudeStore({
          T1: { id: 'cred-1', kind: 'personal', secret: 'oauth-json' },
        }),
        fakeAppTokens(),
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
        fakeClaudeStore({
          T1: { id: 'cred-2', kind: 'setup_token', secret: 'sk-token' },
        }),
        fakeAppTokens(),
      );
      expect(await r.engineAuth('T1', 'claude')).toEqual({
        secret: 'sk-token',
        kind: 'setup-token',
        refreshBack: { orgId: 'T1', engine: 'claude', credentialId: 'cred-2' },
      });
    });

    it('codex: returns undefined when the org has no secret for that engine (engine throws downstream)', async () => {
      const r = new CredentialResolver(
        fakeStore({ T1: {} }),
        fakeClaudeStore({}),
        fakeAppTokens(),
      );
      expect(await r.engineAuth('T1', 'codex')).toBeUndefined();
    });

    it('codex: returns the org codex secret with refreshBack provenance', async () => {
      const r = new CredentialResolver(
        fakeStore({ T1: { codexAuthSecret: 'codex' } }),
        fakeClaudeStore({}),
        fakeAppTokens(),
      );
      expect(await r.engineAuth('T1', 'codex')).toEqual({
        secret: 'codex',
        refreshBack: { orgId: 'T1', engine: 'codex' },
      });
    });

    it('is engine-specific: a selected claude credential does not satisfy a codex request', async () => {
      const r = new CredentialResolver(
        fakeStore({}),
        fakeClaudeStore({
          T1: { id: 'cred-1', kind: 'personal', secret: 'oauth-json' },
        }),
        fakeAppTokens(),
      );
      expect(await r.engineAuth('T1', 'codex')).toBeUndefined();
    });
  });

  describe('githubToken — app mode', () => {
    it('app-mode org with an installation id returns the minted installation token', async () => {
      const r = new CredentialResolver(
        fakeStore({
          T1: {
            githubAuthMode: 'app',
            githubAppInstallationId: '123',
            githubPat: 'ghp_x',
          },
        }),
        fakeClaudeStore({}),
        fakeAppTokens(),
      );
      expect(await r.githubToken('T1')).toBe('ghs_minted');
    });

    it('app-mode org WITHOUT an installation id falls back to the PAT', async () => {
      const r = new CredentialResolver(
        fakeStore({ T1: { githubAuthMode: 'app', githubPat: 'ghp_fallback' } }),
        fakeClaudeStore({}),
        fakeAppTokens(),
      );
      expect(await r.githubToken('T1')).toBe('ghp_fallback');
    });

    it('app-mode org without an installation id AND without a PAT returns undefined', async () => {
      const r = new CredentialResolver(
        fakeStore({ T1: { githubAuthMode: 'app' } }),
        fakeClaudeStore({}),
        fakeAppTokens(),
      );
      expect(await r.githubToken('T1')).toBeUndefined();
    });

    it('app-mode org whose token mint THROWS returns undefined — never throws', async () => {
      const r = new CredentialResolver(
        fakeStore({
          T1: { githubAuthMode: 'app', githubAppInstallationId: '123' },
        }),
        fakeClaudeStore({}),
        fakeAppTokens({
          getInstallationToken: () => {
            throw new Error('mint blip');
          },
        }),
      );
      await expect(r.githubToken('T1')).resolves.toBeUndefined();
    });

    it('pat-mode (default / absent githubAuthMode) still returns the PAT', async () => {
      const r = new CredentialResolver(
        fakeStore({ T1: { githubPat: 'ghp_default' } }),
        fakeClaudeStore({}),
        fakeAppTokens(),
      );
      expect(await r.githubToken('T1')).toBe('ghp_default');

      const r2 = new CredentialResolver(
        fakeStore({ T2: { githubAuthMode: 'pat', githubPat: 'ghp_explicit' } }),
        fakeClaudeStore({}),
        fakeAppTokens(),
      );
      expect(await r2.githubToken('T2')).toBe('ghp_explicit');
    });
  });

  describe('githubCommitIdentity', () => {
    it('returns undefined for pat-mode / no orgId / no row', async () => {
      const r = new CredentialResolver(
        fakeStore({ T1: { githubPat: 'ghp_x' } }),
        fakeClaudeStore({}),
        fakeAppTokens(),
      );
      expect(await r.githubCommitIdentity(undefined)).toBeUndefined();
      expect(await r.githubCommitIdentity('T1')).toBeUndefined();
      expect(await r.githubCommitIdentity('unknown-org')).toBeUndefined();
    });

    it('returns the App bot identity for app-mode orgs', async () => {
      const r = new CredentialResolver(
        fakeStore({
          T1: { githubAuthMode: 'app', githubAppInstallationId: '123' },
        }),
        fakeClaudeStore({}),
        fakeAppTokens({
          appBotIdentity: () =>
            Promise.resolve({ name: 'atlas-bot[bot]', email: 'bot@x' }),
        }),
      );
      expect(await r.githubCommitIdentity('T1')).toEqual({
        name: 'atlas-bot[bot]',
        email: 'bot@x',
      });
    });

    it('is best-effort: a bot-identity resolve failure yields undefined, never throws', async () => {
      const r = new CredentialResolver(
        fakeStore({
          T1: { githubAuthMode: 'app', githubAppInstallationId: '123' },
        }),
        fakeClaudeStore({}),
        fakeAppTokens({
          appBotIdentity: () => {
            throw new Error('boom');
          },
        }),
      );
      await expect(r.githubCommitIdentity('T1')).resolves.toBeUndefined();
    });
  });
});
