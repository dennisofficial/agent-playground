import { REDIS_CLIENT } from '@lib/redis/redis.tokens';
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { randomBytes } from 'node:crypto';

const STATE_TTL_SECONDS = 600;

function stateKey(nonce: string): string {
  return `github_app_state:${nonce}`;
}

export interface GithubAppConnectState {
  orgId: string;
  userId: string | null;
}

@Injectable()
export class GithubAppStateStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async stash(orgId: string, userId: string): Promise<string> {
    const nonce = randomBytes(32).toString('hex');
    const value = JSON.stringify({ orgId, userId } satisfies GithubAppConnectState);
    await this.redis.set(stateKey(nonce), value, 'EX', STATE_TTL_SECONDS);
    return nonce;
  }

  async consume(nonce: string): Promise<GithubAppConnectState | null> {
    // GETDEL (Redis ≥6.2) reads and deletes atomically, so a nonce is single-use — a replayed callback
    // finds nothing. No Lua needed: the single command can't interleave with a concurrent consume.
    const raw = await this.redis.getdel(stateKey(nonce));
    if (typeof raw !== 'string') return null;
    try {
      const parsed = JSON.parse(raw) as GithubAppConnectState;
      if (parsed && typeof parsed.orgId === 'string') {
        return {
          orgId: parsed.orgId,
          userId: typeof parsed.userId === 'string' ? parsed.userId : null,
        };
      }
    } catch {
      // fall through
    }
    return null;
  }
}
