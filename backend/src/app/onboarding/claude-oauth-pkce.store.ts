import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../_lib/redis/redis.tokens';

/** How long a stashed PKCE verifier survives before the authorize round-trip is considered abandoned. */
const PKCE_TTL_SECONDS = 600;

/** One Redis key per (org, state) pair — namespaced so no other Redis use can collide with it. */
function pkceKey(orgId: string, state: string): string {
  return `claude_oauth_pkce:${orgId}:${state}`;
}

/**
 * Short-lived, single-use storage for the PKCE `verifier` between `POST /authorize-url` (stash) and the
 * code exchange (consume) — the org's owner opens the authorize URL and pastes the code back in a separate
 * request, so the verifier has to survive that round-trip somewhere server-side. Redis-backed (not the DB):
 * it's throwaway state with a hard TTL, never queried, never needs to survive a restart.
 */
@Injectable()
export class ClaudeOAuthPkceStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** Stash `verifier` for `(orgId, state)`, expiring after {@link PKCE_TTL_SECONDS}. */
  async stash(orgId: string, state: string, verifier: string): Promise<void> {
    await this.redis.set(
      pkceKey(orgId, state),
      verifier,
      'EX',
      PKCE_TTL_SECONDS,
    );
  }

  /** Read + delete the verifier for `(orgId, state)` — single-use. Null when absent/expired/already consumed. */
  async consume(orgId: string, state: string): Promise<string | null> {
    const key = pkceKey(orgId, state);
    const verifier = await this.redis.get(key);
    await this.redis.del(key);
    return verifier;
  }
}
