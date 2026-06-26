import { EnvService } from '@core/config/env/env.service';
import { Injectable } from '@nestjs/common';
import type { EngineAuth } from '../engine/engine.types';
import { engineAuthFromEnv } from './env-engine-auth';
import { TenantCredentialStore } from './tenant-credential.store';

/**
 * THE credential seam. Every consumer (the LLM factories, the engine runner via the driver, the GitHub
 * token sites) resolves through here instead of reading env directly. Each method returns the TENANT's
 * value when a credential row exists, else falls back to EXACTLY what the old env-only code returned —
 * the load-bearing contract that keeps single-tenant dev (and the whole existing test suite) byte-
 * identical. A `orgId` of `undefined` (or a missing row / null column) always takes the env path.
 */
@Injectable()
export class CredentialResolver {
  constructor(
    private readonly store: TenantCredentialStore,
    private readonly env: EnvService,
  ) {}

  /** Anthropic key for LLM calls: tenant → `ANTHROPIC_API_KEY`. */
  async anthropicKey(orgId?: string): Promise<string | undefined> {
    if (orgId) {
      const creds = await this.store.read(orgId);
      if (creds?.anthropicApiKey) return creds.anthropicApiKey;
    }
    return this.env.get('ANTHROPIC_API_KEY');
  }

  /** OpenAI key for embeddings: tenant → `OPENAI_API_KEY`. */
  async openaiKey(orgId?: string): Promise<string | undefined> {
    if (orgId) {
      const creds = await this.store.read(orgId);
      if (creds?.openaiApiKey) return creds.openaiApiKey;
    }
    return this.env.get('OPENAI_API_KEY');
  }

  /** GitHub token for clone/push/PR: tenant PAT → `GITHUB_TOKEN` → `GITHUB_TOKEN`. */
  async githubToken(orgId?: string): Promise<string | undefined> {
    if (orgId) {
      const creds = await this.store.read(orgId);
      if (creds?.githubPat) return creds.githubPat;
    }
    return this.env.get('GITHUB_TOKEN');
  }

  /**
   * Engine (SDK harness) subscription secret for `engine`: the per-org secret for THAT engine wins,
   * else the env-derived fallback. Subscription-only — returns `undefined` when neither is set so the
   * caller omits `auth` and `EngineCore.resolveAuth` throws (never an API-key fallback).
   */
  async engineAuth(
    orgId: string | undefined,
    engine: 'claude' | 'codex',
  ): Promise<EngineAuth | undefined> {
    if (orgId) {
      const creds = await this.store.read(orgId);
      const secret = engine === 'claude' ? creds?.claudeOauthToken : creds?.codexAuthSecret;
      if (secret) return { secret };
      // A partial/absent posture falls through to the env-derived default.
    }
    return engineAuthFromEnv(this.env, engine);
  }
}
