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

interface BotUserEntry {
  botId: string | undefined;
  expiresAt: number;
}

interface UserIdEntry {
  userId: string | undefined;
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
  /** Separate cache for slackUserId → botId lookups (used by puppet-join detection). */
  private readonly botUserCache = new Map<string, BotUserEntry>();
  /** And the reverse: botId → its Slack bot USER id (joins/invites need the user id, not a token). */
  private readonly userIdCache = new Map<string, UserIdEntry>();

  constructor(private readonly store: SlackIdentityStore) {}

  /** A puppet's Slack bot USER id in a workspace. Reads the stored column first; a manually-PUT
   * row (column null) is backfilled once via the puppet's own `auth.test()`. Cached with the same
   * HIT/MISS TTLs so a fresh install lights up without a restart. */
  async slackUserIdFor(
    teamId: string,
    botId: string,
  ): Promise<string | undefined> {
    const key = `${teamId}|${botId}`;
    const cached = this.userIdCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.userId;
    let userId: string | undefined;
    try {
      userId = await this.store.slackUserIdFor(teamId, botId);
      if (!userId) {
        const client = await this.clientFor(teamId, botId);
        if (client) {
          userId = (await client.auth.test()).user_id;
          if (userId) await this.store.setSlackBotUserId(teamId, botId, userId);
        }
      }
    } catch (err) {
      this.logger.warn(`slackUserIdFor(${teamId}/${botId}) failed: ${err}`);
    }
    this.userIdCache.set(key, {
      userId,
      expiresAt: Date.now() + (userId ? HIT_TTL_MS : MISS_TTL_MS),
    });
    return userId;
  }

  /** Resolve the roster bot_id for a Slack user ID — used by JarvisService to detect puppet-join
   * events in `member_joined_channel`. Cached with MISS_TTL so a newly-installed puppet is
   * recognised within 60s without a restart. */
  async botIdForSlackUser(
    teamId: string,
    slackUserId: string,
  ): Promise<string | undefined> {
    const key = `${teamId}|${slackUserId}`;
    const cached = this.botUserCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.botId;
    try {
      const botId = await this.store.findBotIdBySlackUserId(
        teamId,
        slackUserId,
      );
      this.botUserCache.set(key, {
        botId,
        expiresAt: Date.now() + (botId ? HIT_TTL_MS : MISS_TTL_MS),
      });
      return botId;
    } catch (err) {
      this.logger.warn(
        `botIdForSlackUser(${teamId}/${slackUserId}) failed: ${err}`,
      );
      this.botUserCache.set(key, {
        botId: undefined,
        expiresAt: Date.now() + MISS_TTL_MS,
      });
      return undefined;
    }
  }

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
      this.logger.warn(
        `puppet token resolve(${teamId}/${botId}) failed: ${err}`,
      );
      this.cache.set(key, {
        client: undefined,
        expiresAt: Date.now() + MISS_TTL_MS,
      });
      return undefined;
    }
  }
}
