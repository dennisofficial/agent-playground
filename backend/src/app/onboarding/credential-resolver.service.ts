import { Injectable } from '@nestjs/common';
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
  constructor(
    private readonly store: TenantCredentialStore,
    private readonly claudeStore: ClaudeCredentialStore,
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

  /** GitHub token for clone/push/PR — the org's stored PAT, or undefined. */
  async githubToken(orgId?: string): Promise<string | undefined> {
    if (!orgId) return undefined;
    return (await this.store.read(orgId))?.githubPat;
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
