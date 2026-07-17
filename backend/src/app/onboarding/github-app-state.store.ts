import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { randomBytes } from 'node:crypto';
import { REDIS_CLIENT } from '../../_lib/redis/redis.tokens';

const STATE_TTL_SECONDS = 600;
const CONSUME_SCRIPT = `
local v = redis.call('GET', KEYS[1])
if v then redis.call('DEL', KEYS[1]) end
return v
`;

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
    const value = JSON.stringify({
      orgId,
      userId,
    } satisfies GithubAppConnectState);
    await this.redis.set(stateKey(nonce), value, 'EX', STATE_TTL_SECONDS);
    return nonce;
  }

  async consume(nonce: string): Promise<GithubAppConnectState | null> {
    const raw = await this.redis.eval(CONSUME_SCRIPT, 1, stateKey(nonce));
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
    }
    return { orgId: raw, userId: null };
  }
}
