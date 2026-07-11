import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../_lib/redis/redis.tokens';

/** How long a stashed connect nonce survives before the install round-trip is considered abandoned. */
const STATE_TTL_SECONDS = 600;

/** One Redis key per nonce — namespaced so no other Redis use can collide with it. */
function stateKey(nonce: string): string {
  return `github_app_state:${nonce}`;
}

/**
 * Short-lived, single-use, un-forgeable `state` nonce for the GitHub App connect flow. GitHub's Setup URL
 * callback is un-scoped — it only echoes back the `state` we handed it, not the org — so this is the ONLY
 * thing binding a callback to the org that started the install. A random, server-stashed, one-time nonce
 * (NOT a self-mintable signed blob) is the security control here: it makes the callback un-replayable and
 * un-forgeable, closing the installation-hijack / confused-deputy vector a naive signed-state would open.
 * Redis-backed: throwaway state with a hard TTL, never queried, never needs to survive a restart.
 */
@Injectable()
export class GithubAppStateStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** Mint a fresh nonce bound to `orgId`, expiring after {@link STATE_TTL_SECONDS}. */
  async stash(orgId: string): Promise<string> {
    const nonce = randomBytes(32).toString('hex');
    await this.redis.set(stateKey(nonce), orgId, 'EX', STATE_TTL_SECONDS);
    return nonce;
  }

  /** Read + delete the orgId for `nonce` — single-use. Null when absent/expired/already consumed. */
  async consume(nonce: string): Promise<string | null> {
    const key = stateKey(nonce);
    const orgId = await this.redis.get(key);
    await this.redis.del(key);
    return orgId;
  }
}
