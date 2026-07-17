import { Injectable, Logger } from '@nestjs/common';
import type { EngineAuth, SandboxGitIdentity } from '@shared/engine/engine.types';
import { GitIdentityService } from '../git/git-identity.service';
import { GitHubAppTokenService } from '../git/github-app-token.service';
import { ClaudeCredentialStore } from './claude-credential.store';
import { TenantCredentialStore, type TenantCredentials } from './tenant-credential.store';

/**
 * THE credential seam. Every consumer (the LLM factories, the engine runner via the driver, the GitHub
 * token sites) resolves through here instead of reading env directly. Each method returns the org's
 * per-tenant value from the encrypted `org_credentials` store, or `undefined` when it's absent — there is
 * NO env fallback. Local dev gets its credentials by seeding the dev orgs' rows (`pnpm db:seed`, fed by
 * `.env.seed.enc`), exactly like a deployed org sets them through onboarding. A missing `orgId` / row /
 * column simply yields `undefined`, and the caller handles the absence (the engine throws a clear "no
 * auth" error rather than silently metering an API key).
 */
@Injectable()
export class CredentialResolver {
  private readonly logger = new Logger(CredentialResolver.name);

  constructor(
    private readonly store: TenantCredentialStore,
    private readonly claudeStore: ClaudeCredentialStore,
    private readonly appTokens: GitHubAppTokenService,
    private readonly identities: GitIdentityService,
  ) {}

  /** Anthropic key for LLM calls — the org's stored key, or undefined. */
  async anthropicKey(orgId?: string): Promise<string | undefined> {
    if (!orgId) return undefined;
    return (await this.store.read(orgId))?.anthropicApiKey;
  }

  /** OpenAI key for embeddings — the org's stored key, or undefined. */
  async openaiKey(orgId?: string): Promise<string | undefined> {
    if (!orgId) return undefined;
    return (await this.store.read(orgId))?.openaiApiKey;
  }

  /** Effective in-sandbox GitHub auth mode ('pat' default). Drives whether git uses the file-backed credential helper (app) or a static extraheader (pat). */
  async githubAuthMode(orgId?: string): Promise<'pat' | 'app'> {
    if (!orgId) return 'pat';
    const creds = await this.store.read(orgId);
    return creds ? this.effectiveCredential(creds) : 'pat';
  }

  /** The single credential that governs ALL in-sandbox GitHub auth for this org: 'app' only when app-mode
   *  AND an installation is connected, else 'pat'. Transport, commit identity, and GH_TOKEN all derive from
   *  THIS one choice so the pusher, author, and PR-opener can never diverge. */
  private effectiveCredential(creds: TenantCredentials): 'app' | 'pat' {
    return creds.githubAuthMode === 'app' && creds.githubAppInstallationId ? 'app' : 'pat';
  }

  /** GitHub token for clone/push/PR: an installation token for app-mode orgs, else the org PAT, else undefined. NEVER throws — a mint blip yields undefined (same as an absent PAT). */
  async githubToken(orgId?: string): Promise<string | undefined> {
    if (!orgId) return undefined;
    const creds = await this.store.read(orgId);
    if (!creds) return undefined;
    if (this.effectiveCredential(creds) === 'app') {
      try {
        return await this.appTokens.getInstallationToken(creds.githubAppInstallationId!);
      } catch (e) {
        this.logger.error(
          `installation-token mint failed for org ${orgId}: ${(e as Error).message}`,
        );
        return undefined;
      }
    }
    if (creds.githubAuthMode === 'app' && !creds.githubAppInstallationId) {
      this.logger.warn(`org ${orgId} is app-mode but has no installation id — falling back to PAT`);
    }
    return creds.githubPat;
  }

  /** Identity + matching API token for identity-bearing writes. Identity follows `github_auth_mode` via the
   *  shared `effectiveCredential` selector — no cross-credential fallback, so it can never diverge from
   *  `githubToken`'s choice. Best-effort/fail-open — never throws; {} means no usable credential (caller
   *  omits identity/apiToken). */
  async githubWriteIdentity(
    orgId?: string,
  ): Promise<{ identity?: SandboxGitIdentity; apiToken?: string }> {
    if (!orgId) return {};
    const creds = await this.store.read(orgId);
    if (!creds) return {};
    const cred = this.effectiveCredential(creds);
    if (cred === 'app') {
      try {
        const [identity, apiToken] = await Promise.all([
          this.appTokens.appBotIdentity(),
          this.appTokens.getInstallationToken(creds.githubAppInstallationId!), // present by effectiveCredential
        ]);
        return { identity, apiToken };
      } catch (e) {
        this.logger.warn(
          `app write-identity resolve failed for org ${orgId}: ${(e as Error).message}`,
        );
        return {};
      }
    }
    if (creds.githubPat) {
      const human = await this.identities.resolve(creds.githubPat);
      if (human) return { identity: human, apiToken: creds.githubPat };
    }
    return {}; // no usable credential — fail-open (q6)
  }

  /** Host-side (outside-sandbox) GitHub token: ALWAYS the App installation token when the org has a
   *  connected installation; falls back to the PAT ONLY when no App is connected (pre-App onboarding /
   *  PAT-only orgs). NOT governed by github_auth_mode. NEVER throws — a mint blip yields undefined. */
  async hostGithubToken(orgId?: string): Promise<string | undefined> {
    if (!orgId) return undefined;
    const creds = await this.store.read(orgId);
    if (!creds) return undefined;
    if (!creds.githubAppInstallationId) return creds.githubPat; // App absent → bootstrap/degraded PAT
    try {
      return await this.appTokens.getInstallationToken(creds.githubAppInstallationId);
    } catch (e) {
      this.logger.error(
        `host installation-token mint failed for org ${orgId}: ${(e as Error).message}`,
      );
      return undefined; // App present but mint failed → do NOT leak to PAT
    }
  }

  /**
   * Engine (SDK harness) subscription secret for `engine` — the per-org secret for THAT engine, stamped
   * with `refreshBack` provenance so the auth-refresh write-back can persist a refreshed blob back to the
   * row. Subscription-only — returns `undefined` when the org has no secret for this engine so the caller
   * omits `auth` and `EngineCore.resolveAuth` throws (never an API-key fallback).
   *
   * Claude resolves through the SELECTED `claude_credentials` row (`ClaudeCredentialStore.getSelectedDecrypted`)
   * — the single source of truth, NO legacy-column fallback (the migration guarantees every existing org has
   * a selected row, so `undefined` here means the org genuinely has no Claude credential). The result carries
   * `kind` (`'personal'` vs `'setup-token'`) and `refreshBack.credentialId` so the write-back can target the
   * exact row. Codex is unchanged: resolved from `TenantCredentialStore`.
   */
  async engineAuth(
    orgId: string | undefined,
    engine: 'claude' | 'codex',
  ): Promise<EngineAuth | undefined> {
    if (!orgId) return undefined;
    if (engine === 'claude') {
      const sel = await this.claudeStore.getSelectedDecrypted(orgId);
      if (!sel) return undefined;
      return {
        secret: sel.secret,
        kind: sel.kind === 'personal' ? 'personal' : 'setup-token',
        refreshBack: { orgId, engine: 'claude', credentialId: sel.id },
      };
    }
    const creds = await this.store.read(orgId);
    const secret = creds?.codexAuthSecret;
    if (!secret) return undefined;
    return { secret, refreshBack: { orgId, engine } };
  }
}
