import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../_lib/redis/redis.tokens';

/** How long a stashed connect nonce survives before the install round-trip is considered abandoned. */
const STATE_TTL_SECONDS = 600;
const CONSUME_SCRIPT = `
local v = redis.call('GET', KEYS[1])
if v then redis.call('DEL', KEYS[1]) end
return v
`;

/** One Redis key per nonce — namespaced so no other Redis use can collide with it. */
function stateKey(nonce: string): string {
  return `github_app_state:${nonce}`;
}

/** What a consumed nonce resolves to: the org that started the install + the user who initiated it. */
export interface GithubAppConnectState {
  orgId: string;
  /** The initiating user — drives the common-ownership reuse gate. `null` only for a legacy nonce. */
  userId: string | null;
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

  /** Mint a fresh nonce bound to `orgId` + the initiating `userId`, expiring after {@link STATE_TTL_SECONDS}. */
  async stash(orgId: string, userId: string): Promise<string> {
    const nonce = randomBytes(32).toString('hex');
    const value = JSON.stringify({ orgId, userId } satisfies GithubAppConnectState);
    await this.redis.set(stateKey(nonce), value, 'EX', STATE_TTL_SECONDS);
    return nonce;
  }

  /**
   * Read + delete the state for `nonce` — single-use. Null when absent/expired/already consumed. A legacy
   * nonce (a bare orgId string stashed before this shape existed) degrades to `userId: null`, so the reuse
   * gate can't confirm ownership and fails closed rather than crashing.
   */
  async consume(nonce: string): Promise<GithubAppConnectState | null> {
    const raw = await this.redis.eval(CONSUME_SCRIPT, 1, stateKey(nonce));
    if (typeof raw !== 'string') return null;
    try {
      const parsed = JSON.parse(raw) as GithubAppConnectState;
      if (parsed && typeof parsed.orgId === 'string') {
        return { orgId: parsed.orgId, userId: typeof parsed.userId === 'string' ? parsed.userId : null };
      }
    } catch {
      // Not JSON — a legacy nonce holding a bare orgId.
    }
    return { orgId: raw, userId: null };
  }
}
