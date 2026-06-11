import { Injectable } from '@nestjs/common';
import {
  LLM_PROVIDERS,
  PROVIDER_ENV_KEY,
  type LlmProvider,
} from './llm-key.types';
import { ProviderKeyStore } from './provider-key.store';

/** Resolved provider keys for one workspace (a provider is undefined when neither store nor env has it). */
export type TenantKeys = Partial<Record<LlmProvider, string>>;

/** TTL for the decrypted-key cache (ms). Rotations land on the next tick; a process restart is instant. */
const CACHE_TTL_MS = 60_000;

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
    { keys: TenantKeys; expires: number }
  >();

  constructor(private readonly store: ProviderKeyStore) {}

  /** Decrypted keys for a workspace ({} when none). Store wins; env fills the gaps (dev fallback). */
  async resolve(teamId: string): Promise<TenantKeys> {
    const hit = this.cache.get(teamId);
    if (hit && hit.expires > Date.now()) return hit.keys;
    const keys: TenantKeys = {};
    for (const provider of LLM_PROVIDERS) {
      const stored = await this.store.resolve(teamId, provider);
      keys[provider] =
        stored ?? process.env[PROVIDER_ENV_KEY[provider]] ?? undefined;
    }
    this.cache.set(teamId, { keys, expires: Date.now() + CACHE_TTL_MS });
    return keys;
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
