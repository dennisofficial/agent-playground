import { Injectable, Optional } from '@nestjs/common';
import {
  EWorkerEngineName,
  type EngineAuth,
} from '../engines/worker-engine.port';
import {
  LLM_PROVIDERS,
  PROVIDER_ENV_KEY,
  type LlmProvider,
  type ProviderCredential,
} from './llm-key.types';
import { CredentialRotationBus } from './credential-rotation.bus';
import { ProviderKeyStore } from './provider-key.store';

/** Resolved API keys for one workspace (a provider is undefined when neither store nor env has it).
 * The API key funds chat/gate/embeddings and 'api_key'-mode engine turns — engine auth that may
 * differ (subscription) is resolved separately via `engineAuth()`. */
export type TenantKeys = Partial<Record<LlmProvider, string>>;

/** The full per-provider credentials for a workspace (API key + engine auth mode + subscription). */
type TenantCredentials = Partial<Record<LlmProvider, ProviderCredential>>;

/** TTL for the decrypted-credential cache (ms). Rotations land on the next tick; a restart is instant. */
const CACHE_TTL_MS = 60_000;

/** Which provider funds a given engine's turns: Codex → OpenAI, everything else (Claude/LangGraph)
 * → Anthropic. Shared by `engineAuth()` and the call sites that build it. */
export const engineProvider = (engine: EWorkerEngineName): LlmProvider =>
  engine === EWorkerEngineName.CODEX ? 'openai' : 'anthropic';

/**
 * The single-process replacement for "tenant = process, keys on process.env". Resolves a workspace's
 * LLM keys (decrypted from `provider_keys`, or the process env as a DEV fallback) and hands them to
 * the model/embedding/engine builders EXPLICITLY — never via process.env, which can hold only one
 * tenant's key. Short TTL cache so a busy workspace doesn't re-decrypt every turn.
 *
 * Env fallback (dev/TUI): when a workspace has no stored key for a provider, `process.env`'s key is
 * used. On a tenant box, leave the env keys unset so each workspace must bring its own.
 */
@Injectable()
export class TenantCredentialService {
  private readonly cache = new Map<
    string,
    { creds: TenantCredentials; expires: number }
  >();

  constructor(
    private readonly store: ProviderKeyStore,
    // OPTIONAL so LlmKeysModule stays composable WITHOUT the harness (the api app / store int tests
    // import it standalone, with no @Global CredentialModule). When present (the harness), a rotation
    // drops THIS team's decrypted-key cache so the next resolve re-reads the fresh key.
    @Optional() rotation?: CredentialRotationBus,
  ) {
    rotation?.rotated$.subscribe((teamId) => this.invalidate(teamId));
  }

  /** Decrypted per-provider credentials for a workspace (cached). Store wins; the API key falls back
   * to process.env (dev). The subscription secret + mode come from the store only. */
  private async load(teamId: string): Promise<TenantCredentials> {
    const hit = this.cache.get(teamId);
    if (hit && hit.expires > Date.now()) return hit.creds;
    const creds: TenantCredentials = {};
    for (const provider of LLM_PROVIDERS) {
      const stored = await this.store.resolveCredential(teamId, provider);
      creds[provider] = {
        apiKey:
          stored?.apiKey ?? process.env[PROVIDER_ENV_KEY[provider]] ?? undefined,
        engineAuthMode: stored?.engineAuthMode ?? 'api_key',
        subscriptionSecret: stored?.subscriptionSecret,
      };
    }
    this.cache.set(teamId, { creds, expires: Date.now() + CACHE_TTL_MS });
    return creds;
  }

  /** Decrypted API keys for a workspace ({} when none). Store wins; env fills the gaps (dev fallback).
   * Funds chat/gate/embeddings (and 'api_key'-mode engine turns). */
  async resolve(teamId: string): Promise<TenantKeys> {
    const creds = await this.load(teamId);
    const keys: TenantKeys = {};
    for (const provider of LLM_PROVIDERS) keys[provider] = creds[provider]?.apiKey;
    return keys;
  }

  /** How a given engine's turn should authenticate for this workspace — THE single builder used by
   * every engine-turn call site (session runner, plan self-review, review pipeline). Returns
   * 'subscription' only when the funding provider is in subscription mode AND has a stored secret;
   * otherwise the metered API key ('api_key' mode), so it degrades safely. */
  async engineAuth(
    teamId: string,
    engine: EWorkerEngineName,
  ): Promise<EngineAuth> {
    const cred = (await this.load(teamId))[engineProvider(engine)];
    if (cred?.engineAuthMode === 'subscription' && cred.subscriptionSecret) {
      return { mode: 'subscription', secret: cred.subscriptionSecret };
    }
    return { mode: 'api_key', apiKey: cred?.apiKey };
  }

  /** True when every required provider key is resolvable for this workspace. */
  async isReady(teamId: string): Promise<boolean> {
    const keys = await this.resolve(teamId);
    return LLM_PROVIDERS.every((p) => !!keys[p]);
  }

  /** Throws if a provider key is missing — for builders that cannot proceed keyless. */
  async require(teamId: string, provider: LlmProvider): Promise<string> {
    const key = (await this.resolve(teamId))[provider];
    if (!key) {
      throw new Error(
        `No ${provider} key for workspace ${teamId} (store + ${PROVIDER_ENV_KEY[provider]} env both empty).`,
      );
    }
    return key;
  }

  /** Drop the cached keys for a workspace (after a key write/rotation). */
  invalidate(teamId: string): void {
    this.cache.delete(teamId);
  }
}
