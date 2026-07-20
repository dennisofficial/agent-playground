import { describe, expect, it } from 'vitest';
import type { GitIdentityService } from '../../git/git-identity.service';
import type { GitHubAppTokenService } from '../../git/github-app-token.service';
import type { ClaudeCredentialStore } from '../claude-credential.store';
import { CredentialResolver } from '../credential-resolver.service';
import type { TenantCredentials, TenantCredentialStore } from '../tenant-credential.store';

function fakeStore(rows: Record<string, TenantCredentials | null>): TenantCredentialStore {
  return {
    read: (orgId: string) => Promise.resolve(rows[orgId] ?? null),
  } as unknown as TenantCredentialStore;
}

function fakeClaudeStore(
  rows: Record<string, { id: string; kind: 'setup_token' | 'personal'; secret: string } | null>,
): ClaudeCredentialStore {
  return {
    getSelectedDecrypted: (orgId: string) => Promise.resolve(rows[orgId] ?? null),
  } as unknown as ClaudeCredentialStore;
}

function fakeAppTokens(
  overrides: {
    getInstallationToken?: (installationId: string) => Promise<string>;
    appBotIdentity?: () => Promise<{ name: string; email: string }>;
  } = {},
): GitHubAppTokenService {
  return {
    getInstallationToken: overrides.getInstallationToken ?? (() => Promise.resolve('ghs_minted')),
    appBotIdentity:
      overrides.appBotIdentity ?? (() => Promise.resolve({ name: 'x[bot]', email: 'x' })),
  } as unknown as GitHubAppTokenService;
}

function fakeIdentities(
  resolve?: (token: string) => Promise<{ name: string; email: string } | undefined>,
): GitIdentityService {
  return {
    resolve:
      resolve ??
      (() =>
        Promise.resolve({
          name: 'Dev',
          email: '42+dev@users.noreply.github.com',
        })),
  } as unknown as GitIdentityService;
}

describe('CredentialResolver — per-org rows, no env fallback', () => {
  describe('anthropicKey / openaiKey / githubToken', () => {
    it('returns undefined when orgId is missing', async () => {
      const r = new CredentialResolver(
        fakeStore({}),
        fakeClaudeStore({}),
        fakeAppTokens(),
        fakeIdentities(),
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
        fakeIdentities(),
      );
      expect(await r.anthropicKey('T1')).toBeUndefined();
      expect(await r.githubToken('T1')).toBeUndefined();
    });

    it('returns undefined when the row lacks that credential', async () => {
      const r = new CredentialResolver(
        fakeStore({ T1: {} }),
        fakeClaudeStore({}),
        fakeAppTokens(),
        fakeIdentities(),
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
        fakeIdentities(),
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
        fakeIdentities(),
      );
      expect(await r.engineAuth(undefined, 'claude')).toBeUndefined();
      expect(await r.engineAuth(undefined, 'codex')).toBeUndefined();
    });

    it('claude: returns undefined when no credential is selected (no legacy fallback)', async () => {
      const r = new CredentialResolver(
        fakeStore({ T1: { claudeOauthToken: 'legacy' } }),
        fakeClaudeStore({ T1: null }),
        fakeAppTokens(),
        fakeIdentities(),
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
        fakeIdentities(),
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
        fakeIdentities(),
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
        fakeIdentities(),
      );
      expect(await r.engineAuth('T1', 'codex')).toBeUndefined();
    });

    it('codex: returns the org codex secret with refreshBack provenance', async () => {
      const r = new CredentialResolver(
        fakeStore({ T1: { codexAuthSecret: 'codex' } }),
        fakeClaudeStore({}),
        fakeAppTokens(),
        fakeIdentities(),
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
        fakeIdentities(),
      );
      expect(await r.engineAuth('T1', 'codex')).toBeUndefined();
    });
  });

  describe('githubToken — app mode', () => {
    it('githubAuthMode returns the effective in-sandbox transport mode, not a raw app setting without an installation', async () => {
      const r = new CredentialResolver(
        fakeStore({ T1: { githubAuthMode: 'app', githubPat: 'ghp_fallback' } }),
        fakeClaudeStore({}),
        fakeAppTokens(),
        fakeIdentities(),
      );
      expect(await r.githubAuthMode('T1')).toBe('pat');

      const r2 = new CredentialResolver(
        fakeStore({
          T2: { githubAuthMode: 'app', githubAppInstallationId: '123' },
        }),
        fakeClaudeStore({}),
        fakeAppTokens(),
        fakeIdentities(),
      );
      expect(await r2.githubAuthMode('T2')).toBe('app');
    });

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
        fakeIdentities(),
      );
      expect(await r.githubToken('T1')).toBe('ghs_minted');
    });

    it('app-mode org WITHOUT an installation id falls back to the PAT', async () => {
      const r = new CredentialResolver(
        fakeStore({ T1: { githubAuthMode: 'app', githubPat: 'ghp_fallback' } }),
        fakeClaudeStore({}),
        fakeAppTokens(),
        fakeIdentities(),
      );
      expect(await r.githubToken('T1')).toBe('ghp_fallback');
    });

    it('app-mode org without an installation id AND without a PAT returns undefined', async () => {
      const r = new CredentialResolver(
        fakeStore({ T1: { githubAuthMode: 'app' } }),
        fakeClaudeStore({}),
        fakeAppTokens(),
        fakeIdentities(),
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
        fakeIdentities(),
      );
      await expect(r.githubToken('T1')).resolves.toBeUndefined();
    });

    it('pat-mode (default / absent githubAuthMode) still returns the PAT', async () => {
      const r = new CredentialResolver(
        fakeStore({ T1: { githubPat: 'ghp_default' } }),
        fakeClaudeStore({}),
        fakeAppTokens(),
        fakeIdentities(),
      );
      expect(await r.githubToken('T1')).toBe('ghp_default');

      const r2 = new CredentialResolver(
        fakeStore({ T2: { githubAuthMode: 'pat', githubPat: 'ghp_explicit' } }),
        fakeClaudeStore({}),
        fakeAppTokens(),
        fakeIdentities(),
      );
      expect(await r2.githubToken('T2')).toBe('ghp_explicit');
    });
  });

  describe('githubWriteIdentity — resolves from the SAME effectiveCredential as githubToken, no cross-credential fallback', () => {
    it('no orgId → {}', async () => {
      const r = new CredentialResolver(
        fakeStore({ T1: { githubPat: 'ghp_x' } }),
        fakeClaudeStore({}),
        fakeAppTokens(),
        fakeIdentities(),
      );
      expect(await r.githubWriteIdentity(undefined)).toEqual({});
    });

    it('no row for the org → {}', async () => {
      const r = new CredentialResolver(
        fakeStore({}),
        fakeClaudeStore({}),
        fakeAppTokens(),
        fakeIdentities(),
      );
      expect(await r.githubWriteIdentity('unknown-org')).toEqual({});
    });

    it('neither a PAT nor an installation → {}', async () => {
      const r = new CredentialResolver(
        fakeStore({ T1: {} }),
        fakeClaudeStore({}),
        fakeAppTokens(),
        fakeIdentities(),
      );
      expect(await r.githubWriteIdentity('T1')).toEqual({});
    });

    it('pat-mode (default githubAuthMode): resolves the human identity + the PAT as apiToken', async () => {
      const r = new CredentialResolver(
        fakeStore({ T1: { githubPat: 'ghp_x' } }),
        fakeClaudeStore({}),
        fakeAppTokens(),
        fakeIdentities(),
      );
      expect(await r.githubWriteIdentity('T1')).toEqual({
        identity: { name: 'Dev', email: '42+dev@users.noreply.github.com' },
        apiToken: 'ghp_x',
      });
    });

    it('an installation exists but githubAuthMode is NOT "app": stays on the PAT (no App identity without opting into app mode)', async () => {
      const r = new CredentialResolver(
        fakeStore({ T1: { githubAppInstallationId: '123' } }),
        fakeClaudeStore({}),
        fakeAppTokens({
          appBotIdentity: () => Promise.resolve({ name: 'atlas-bot[bot]', email: 'bot@x' }),
          getInstallationToken: () => Promise.resolve('ghs_minted'),
        }),
        fakeIdentities(),
      );
      expect(await r.githubWriteIdentity('T1')).toEqual({});
    });

    it('app-mode + installation, no PAT: resolves the App bot + the installation token', async () => {
      const r = new CredentialResolver(
        fakeStore({
          T1: { githubAuthMode: 'app', githubAppInstallationId: '123' },
        }),
        fakeClaudeStore({}),
        fakeAppTokens({
          appBotIdentity: () => Promise.resolve({ name: 'atlas-bot[bot]', email: 'bot@x' }),
          getInstallationToken: () => Promise.resolve('ghs_minted'),
        }),
        fakeIdentities(),
      );
      expect(await r.githubWriteIdentity('T1')).toEqual({
        identity: { name: 'atlas-bot[bot]', email: 'bot@x' },
        apiToken: 'ghs_minted',
      });
    });

    it('both credentials present, githubAuthMode unset (default pat): resolves the human identity + PAT', async () => {
      const r = new CredentialResolver(
        fakeStore({
          T1: { githubPat: 'ghp_x', githubAppInstallationId: '123' },
        }),
        fakeClaudeStore({}),
        fakeAppTokens(),
        fakeIdentities(),
      );
      expect(await r.githubWriteIdentity('T1')).toEqual({
        identity: { name: 'Dev', email: '42+dev@users.noreply.github.com' },
        apiToken: 'ghp_x',
      });
    });

    it('both credentials present, githubAuthMode explicitly "pat": resolves the human identity + PAT', async () => {
      const r = new CredentialResolver(
        fakeStore({
          T1: {
            githubAuthMode: 'pat',
            githubPat: 'ghp_x',
            githubAppInstallationId: '123',
          },
        }),
        fakeClaudeStore({}),
        fakeAppTokens(),
        fakeIdentities(),
      );
      expect(await r.githubWriteIdentity('T1')).toEqual({
        identity: { name: 'Dev', email: '42+dev@users.noreply.github.com' },
        apiToken: 'ghp_x',
      });
    });

    it('both credentials present, githubAuthMode "app": resolves the App bot + installation token, NOT the PAT', async () => {
      const r = new CredentialResolver(
        fakeStore({
          T1: {
            githubAuthMode: 'app',
            githubPat: 'ghp_x',
            githubAppInstallationId: '123',
          },
        }),
        fakeClaudeStore({}),
        fakeAppTokens({
          appBotIdentity: () => Promise.resolve({ name: 'atlas-bot[bot]', email: 'bot@x' }),
          getInstallationToken: () => Promise.resolve('ghs_minted'),
        }),
        fakeIdentities(),
      );
      expect(await r.githubWriteIdentity('T1')).toEqual({
        identity: { name: 'atlas-bot[bot]', email: 'bot@x' },
        apiToken: 'ghs_minted',
      });
    });

    it('pat-mode, PAT present but invalid (identities.resolve → undefined): returns {} — NO fallback to the App bot', async () => {
      const r = new CredentialResolver(
        fakeStore({
          T1: { githubPat: 'ghp_stale', githubAppInstallationId: '123' },
        }),
        fakeClaudeStore({}),
        fakeAppTokens({
          appBotIdentity: () => Promise.resolve({ name: 'atlas-bot[bot]', email: 'bot@x' }),
          getInstallationToken: () => Promise.resolve('ghs_minted'),
        }),
        fakeIdentities(() => Promise.resolve(undefined)),
      );
      expect(await r.githubWriteIdentity('T1')).toEqual({});
    });

    it('PAT invalid and no installation → {} (never throws)', async () => {
      const r = new CredentialResolver(
        fakeStore({ T1: { githubPat: 'ghp_stale' } }),
        fakeClaudeStore({}),
        fakeAppTokens(),
        fakeIdentities(() => Promise.resolve(undefined)),
      );
      expect(await r.githubWriteIdentity('T1')).toEqual({});
    });

    it('is best-effort: the App branch throwing (appBotIdentity or getInstallationToken) yields {}, never throws', async () => {
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
        fakeIdentities(),
      );
      await expect(r.githubWriteIdentity('T1')).resolves.toEqual({});
    });

    it('app-mode with BOTH credentials: an App-branch throw yields {} — NO fallback to the PAT', async () => {
      const r = new CredentialResolver(
        fakeStore({
          T1: {
            githubAuthMode: 'app',
            githubPat: 'ghp_x',
            githubAppInstallationId: '123',
          },
        }),
        fakeClaudeStore({}),
        fakeAppTokens({
          getInstallationToken: () => {
            throw new Error('mint blip');
          },
        }),
        fakeIdentities(),
      );
      expect(await r.githubWriteIdentity('T1')).toEqual({});
    });
  });

  describe('githubToken and githubWriteIdentity never diverge (pusher = author)', () => {
    it('app-mode + installation: BOTH resolve the App (bot identity + app token)', async () => {
      const creds: TenantCredentials = {
        githubAuthMode: 'app',
        githubAppInstallationId: '123',
        githubPat: 'ghp_x',
      };
      const r = new CredentialResolver(
        fakeStore({ T1: creds }),
        fakeClaudeStore({}),
        fakeAppTokens({
          appBotIdentity: () => Promise.resolve({ name: 'atlas-bot[bot]', email: 'bot@x' }),
          getInstallationToken: () => Promise.resolve('ghs_minted'),
        }),
        fakeIdentities(),
      );
      expect(await r.githubToken('T1')).toBe('ghs_minted');
      expect(await r.githubWriteIdentity('T1')).toEqual({
        identity: { name: 'atlas-bot[bot]', email: 'bot@x' },
        apiToken: 'ghs_minted',
      });
    });

    it('app-mode + NO installation: BOTH resolve the PAT (human identity)', async () => {
      const creds: TenantCredentials = {
        githubAuthMode: 'app',
        githubPat: 'ghp_x',
      };
      const r = new CredentialResolver(
        fakeStore({ T1: creds }),
        fakeClaudeStore({}),
        fakeAppTokens(),
        fakeIdentities(),
      );
      expect(await r.githubToken('T1')).toBe('ghp_x');
      expect(await r.githubWriteIdentity('T1')).toEqual({
        identity: { name: 'Dev', email: '42+dev@users.noreply.github.com' },
        apiToken: 'ghp_x',
      });
    });
  });

  describe('hostGithubToken — host-side calls always prefer the App, PAT only when no App is connected', () => {
    it('no orgId → undefined', async () => {
      const r = new CredentialResolver(
        fakeStore({ T1: { githubPat: 'ghp_x' } }),
        fakeClaudeStore({}),
        fakeAppTokens(),
        fakeIdentities(),
      );
      expect(await r.hostGithubToken(undefined)).toBeUndefined();
    });

    it('no row for the org → undefined', async () => {
      const r = new CredentialResolver(
        fakeStore({}),
        fakeClaudeStore({}),
        fakeAppTokens(),
        fakeIdentities(),
      );
      expect(await r.hostGithubToken('unknown-org')).toBeUndefined();
    });

    it('installation present: returns the minted App installation token, regardless of githubAuthMode', async () => {
      const r = new CredentialResolver(
        fakeStore({
          T1: {
            githubAuthMode: 'pat',
            githubAppInstallationId: '123',
            githubPat: 'ghp_x',
          },
        }),
        fakeClaudeStore({}),
        fakeAppTokens({
          getInstallationToken: () => Promise.resolve('ghs_host_minted'),
        }),
        fakeIdentities(),
      );
      expect(await r.hostGithubToken('T1')).toBe('ghs_host_minted');
    });

    it('no installation, PAT present: returns the PAT', async () => {
      const r = new CredentialResolver(
        fakeStore({ T1: { githubPat: 'ghp_x' } }),
        fakeClaudeStore({}),
        fakeAppTokens(),
        fakeIdentities(),
      );
      expect(await r.hostGithubToken('T1')).toBe('ghp_x');
    });

    it('installation present but mint throws: returns undefined — NO fallback to the PAT', async () => {
      const r = new CredentialResolver(
        fakeStore({
          T1: { githubAppInstallationId: '123', githubPat: 'ghp_x' },
        }),
        fakeClaudeStore({}),
        fakeAppTokens({
          getInstallationToken: () => {
            throw new Error('mint blip');
          },
        }),
        fakeIdentities(),
      );
      await expect(r.hostGithubToken('T1')).resolves.toBeUndefined();
    });
  });
});
