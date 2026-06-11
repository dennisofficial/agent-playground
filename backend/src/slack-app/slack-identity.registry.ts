import { SlackIdentityStore } from '@harness/slack-identities/slack-identity.store';
import { Injectable, Logger } from '@nestjs/common';
import { LogLevel, WebClient } from '@slack/web-api';

/** Positive entries re-resolve after this — token rotation (DELETE+PUT) lands within one TTL. */
const HIT_TTL_MS = 10 * 60_000;
/** Misses re-check after this — a freshly PUT token lights the puppet up without a restart
 * (the cross-process seam: the api process writes, this process polls lazily). */
const MISS_TTL_MS = 60_000;

interface CacheEntry {
  client?: WebClient;
  expiresAt: number;
}

/**
 * Read-through `botId → WebClient` cache over the puppet-token store. `undefined` = no puppet for
 * that employee — callers fall back to the main app + `username` override (the pre-puppet
 * behavior), so a half-configured workspace degrades gracefully per employee.
 */
@Injectable()
export class SlackIdentityRegistry {
  private readonly logger = new Logger(SlackIdentityRegistry.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly store: SlackIdentityStore) {}

  async clientFor(
    teamId: string,
    botId: string,
  ): Promise<WebClient | undefined> {
    const key = `${teamId}|${botId}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.client;
    try {
      const token = await this.store.resolve(teamId, botId);
      const client = token
        ? new WebClient(token, { logLevel: LogLevel.WARN })
        : undefined;
      this.cache.set(key, {
        client,
        expiresAt: Date.now() + (client ? HIT_TTL_MS : MISS_TTL_MS),
      });
      return client;
    } catch (err) {
      // Cipher unset/misconfigured or DB hiccup — degrade to the fallback identity, retry later.
      this.logger.warn(`puppet token resolve(${teamId}/${botId}) failed: ${err}`);
      this.cache.set(key, { client: undefined, expiresAt: Date.now() + MISS_TTL_MS });
      return undefined;
    }
  }
}
