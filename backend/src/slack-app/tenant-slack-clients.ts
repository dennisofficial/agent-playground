import { EnvService } from '@core/config/env/env.service';
import { SecretCipher } from '@harness/projects/secret-cipher';
import { Injectable, Logger } from '@nestjs/common';
import { LogLevel, WebClient } from '@slack/web-api';
import { TenantStore } from './tenant.store';

/** Positive entries re-resolve after this — a reinstall (token rotation) lands within one TTL. */
const HIT_TTL_MS = 10 * 60_000;
/** Misses re-check after this — a freshly installed workspace lights up without a restart. */
const MISS_TTL_MS = 60_000;

interface ClientEntry {
  client?: WebClient;
  expiresAt: number;
}

/**
 * The per-workspace "ears" WebClient — the OAuth-distributed main app's bot token DIFFERS per
 * install, so reads (users.info / conversations.info / auth.test) and fallback posts must use the
 * RIGHT workspace's token, resolved from the `tenants` row (`bot_token_ciphertext`, decrypted here).
 * Read-through cache, same shape as SlackIdentityRegistry. Falls back to the `SLACK_BOT_TOKEN` env
 * (the dev Socket-Mode app's single-workspace token) when a workspace has no stored token — so local
 * dev needs no install. `undefined` = no token for that workspace yet (caller degrades/skips).
 */
@Injectable()
export class TenantSlackClients {
  private readonly logger = new Logger(TenantSlackClients.name);
  private readonly clients = new Map<string, ClientEntry>();
  private readonly selfIds = new Map<string, string | undefined>();
  private readonly envClient?: WebClient;

  constructor(
    private readonly tenants: TenantStore,
    private readonly cipher: SecretCipher,
    env: EnvService,
  ) {
    const envToken = env.get('SLACK_BOT_TOKEN');
    if (envToken) {
      this.envClient = new WebClient(envToken, { logLevel: LogLevel.WARN });
    }
  }

  /** The ears WebClient for a workspace (stored token → env fallback), or undefined when neither. */
  async clientFor(teamId: string): Promise<WebClient | undefined> {
    const hit = this.clients.get(teamId);
    if (hit && hit.expiresAt > Date.now()) return hit.client;
    let client: WebClient | undefined;
    try {
      const ciphertext = await this.tenants.resolveBotTokenCiphertext(teamId);
      if (ciphertext) {
        client = new WebClient(this.cipher.decrypt(ciphertext), {
          logLevel: LogLevel.WARN,
        });
      }
    } catch (err) {
      this.logger.warn(`ears token resolve(${teamId}) failed: ${err}`);
    }
    client ??= this.envClient; // dev / single-workspace fallback
    this.clients.set(teamId, {
      client,
      expiresAt: Date.now() + (client ? HIT_TTL_MS : MISS_TTL_MS),
    });
    return client;
  }

  /** Boot-banner identity from the env (dev Socket-Mode) token — empty in prod (no env token until
   * a workspace installs; identities are then per-team via selfUserIdFor). Cosmetic only. */
  async bootIdentity(): Promise<{ botName?: string }> {
    try {
      const res = await this.envClient?.auth.test();
      return { botName: res?.user };
    } catch {
      return {};
    }
  }

  /** This app's bot user id IN a workspace (auth.test, cached) — differs per install. Used by the
   * echo-loop guard + self-mention translation. Undefined when the workspace has no token yet. */
  async selfUserIdFor(teamId: string): Promise<string | undefined> {
    if (this.selfIds.has(teamId)) return this.selfIds.get(teamId);
    const client = await this.clientFor(teamId);
    let userId: string | undefined;
    try {
      if (client) userId = (await client.auth.test()).user_id;
    } catch (err) {
      this.logger.warn(`auth.test(${teamId}) failed: ${err}`);
    }
    if (userId) this.selfIds.set(teamId, userId); // cache only a real hit (retry a miss next time)
    return userId;
  }
}
