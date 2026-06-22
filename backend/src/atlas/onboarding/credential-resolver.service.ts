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
 * identical. A `teamId` of `undefined` (or a missing row / null column) always takes the env path.
 */
@Injectable()
export class CredentialResolver {
  constructor(
    private readonly store: TenantCredentialStore,
    private readonly env: EnvService,
  ) {}

  /** Anthropic key for LLM calls: tenant → `ANTHROPIC_API_KEY`. */
  async anthropicKey(teamId?: string): Promise<string | undefined> {
    if (teamId) {
      const creds = await this.store.read(teamId);
      if (creds?.anthropicApiKey) return creds.anthropicApiKey;
    }
    return this.env.get('ANTHROPIC_API_KEY');
  }

  /** OpenAI key for embeddings: tenant → `OPENAI_API_KEY`. */
  async openaiKey(teamId?: string): Promise<string | undefined> {
    if (teamId) {
      const creds = await this.store.read(teamId);
      if (creds?.openaiApiKey) return creds.openaiApiKey;
    }
    return this.env.get('OPENAI_API_KEY');
  }

  /** GitHub token for clone/push/PR: tenant PAT → `ATLAS_GITHUB_TOKEN` → `GITHUB_TOKEN`. */
  async githubToken(teamId?: string): Promise<string | undefined> {
    if (teamId) {
      const creds = await this.store.read(teamId);
      if (creds?.githubPat) return creds.githubPat;
    }
    return this.env.get('ATLAS_GITHUB_TOKEN') ?? this.env.get('GITHUB_TOKEN');
  }

  /** Engine auth (the EngineAuth union): tenant posture → the env-derived fallback (byte-identical). */
  async engineAuth(teamId: string | undefined, engine: 'claude' | 'codex'): Promise<EngineAuth> {
    if (teamId) {
      const creds = await this.store.read(teamId);
      if (creds) {
        if (creds.engineAuthMode === 'subscription' && creds.engineAuthSecret) {
          return { mode: 'subscription', secret: creds.engineAuthSecret };
        }
        if (creds.engineAuthMode === 'api_key' && creds.anthropicApiKey) {
          return { mode: 'api_key', apiKey: creds.anthropicApiKey };
        }
        // A partial/absent posture falls through to the env-derived default.
      }
    }
    return engineAuthFromEnv(this.env, engine);
  }
}
