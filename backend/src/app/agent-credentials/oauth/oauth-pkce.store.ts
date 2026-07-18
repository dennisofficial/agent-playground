import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../../_lib/redis/redis.tokens';

const PKCE_TTL_SECONDS = 600;

function pkceKey(orgId: string, state: string): string {
  return `agent_oauth_pkce:${orgId}:${state}`;
}

/** Short-lived (10 min) one-time store for the Claude OAuth PKCE verifier, keyed by (org, state). */
@Injectable()
export class OAuthPkceStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async stash(orgId: string, state: string, verifier: string): Promise<void> {
    await this.redis.set(pkceKey(orgId, state), verifier, 'EX', PKCE_TTL_SECONDS);
  }

  /** Fetch and delete (single-use) the verifier for an (org, state), or null if expired/absent. */
  async consume(orgId: string, state: string): Promise<string | null> {
    const key = pkceKey(orgId, state);
    const verifier = await this.redis.get(key);
    await this.redis.del(key);
    return verifier;
  }
}
