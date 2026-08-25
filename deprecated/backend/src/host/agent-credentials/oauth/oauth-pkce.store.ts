import { REDIS_CLIENT } from '@lib/redis/redis.tokens';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';

const PKCE_TTL_SECONDS = 600;

@Injectable()
export class OAuthPkceStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async stash(orgId: string, state: string, verifier: string): Promise<void> {
    await this.redis.set(OAuthPkceStore.pkceKey(orgId, state), verifier, 'EX', PKCE_TTL_SECONDS);
  }

  /** Fetch and delete (single-use) the verifier for an (org, state), or null if expired/absent. */
  async consume(orgId: string, state: string): Promise<string | null> {
    const key = OAuthPkceStore.pkceKey(orgId, state);
    const verifier = await this.redis.get(key);
    await this.redis.del(key);
    return verifier;
  }

  private static pkceKey(orgId: string, state: string): string {
    return `agent_oauth_pkce:${orgId}:${state}`;
  }
}
