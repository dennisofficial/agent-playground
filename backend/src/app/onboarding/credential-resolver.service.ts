import { Injectable, Logger } from '@nestjs/common';
import { GitHubAppTokenService } from '../git/github-app-token.service';
import type { EngineAuth } from '../engine/engine.types';
import { ClaudeCredentialStore } from './claude-credential.store';
import { TenantCredentialStore } from './tenant-credential.store';

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

  /** GitHub token for clone/push/PR: an installation token for app-mode orgs, else the org PAT, else undefined. NEVER throws — a mint blip yields undefined (same as an absent PAT). */
  async githubToken(orgId?: string): Promise<string | undefined> {
    if (!orgId) return undefined;
    const creds = await this.store.read(orgId);
    if (!creds) return undefined;
    if (creds.githubAuthMode === 'app') {
      if (!creds.githubAppInstallationId) {
        this.logger.warn(
          `org ${orgId} is app-mode but has no installation id — falling back to PAT`,
        );
        return creds.githubPat;
      }
      try {
        return await this.appTokens.getInstallationToken(
          creds.githubAppInstallationId,
        );
      } catch (e) {
        this.logger.error(
          `installation-token mint failed for org ${orgId}: ${(e as Error).message}`,
        );
        return undefined;
      }
    }
    return creds.githubPat;
  }

  /** Commit identity for app-mode orgs (the App's bot, since an installation token is not a user); undefined for pat-mode (callers fall back to GitIdentityService.resolve(token)). Best-effort — never throws. */
  async githubCommitIdentity(
    orgId?: string,
  ): Promise<{ name: string; email: string } | undefined> {
    if (!orgId) return undefined;
    const creds = await this.store.read(orgId);
    if (creds?.githubAuthMode !== 'app') return undefined;
    try {
      return await this.appTokens.appBotIdentity();
    } catch (e) {
      this.logger.warn(
        `app bot identity resolve failed for org ${orgId}: ${(e as Error).message}`,
      );
      return undefined;
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
