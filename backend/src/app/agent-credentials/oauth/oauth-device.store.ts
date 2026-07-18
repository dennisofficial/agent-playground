import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { randomBytes } from 'node:crypto';
import { REDIS_CLIENT } from '../../../_lib/redis/redis.tokens';

/** In-flight Codex device-auth state, referenced by an opaque handle (never expose the raw device code). */
export type CodexDeviceState = { orgId: string; deviceAuthId: string; userCode: string };

function deviceKey(handle: string): string {
  return `agent_oauth_device:${handle}`;
}

/**
 * Short-lived store for a running Codex device-code login, keyed by an opaque handle the client polls with.
 * TTL matches the device code's ~15-minute lifetime. NOT single-use — the client polls the same handle
 * repeatedly until complete/expired.
 */
@Injectable()
export class OAuthDeviceStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async stash(state: CodexDeviceState, ttlSeconds: number): Promise<string> {
    const handle = randomBytes(24).toString('base64url');
    await this.redis.set(deviceKey(handle), JSON.stringify(state), 'EX', Math.max(1, ttlSeconds));
    return handle;
  }

  /** Read the state for a handle, scoped to the org, or null if expired/absent/mismatched. */
  async get(handle: string, orgId: string): Promise<CodexDeviceState | null> {
    const raw = await this.redis.get(deviceKey(handle));
    if (!raw) return null;
    const state = JSON.parse(raw) as CodexDeviceState;
    return state.orgId === orgId ? state : null;
  }

  async remove(handle: string): Promise<void> {
    await this.redis.del(deviceKey(handle));
  }
}
