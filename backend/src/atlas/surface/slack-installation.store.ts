import { EnvService } from '@core/config/env/env.service';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { decryptSecret, encryptSecret, loadSecretsKey } from '../onboarding/secret-cipher';
import { ATLAS_CONNECTION } from '../persistence/atlas-database.module';
import { AtlasSlackInstallation } from '../persistence/entities';

/** A workspace OAuth install — what `/slack/oauth_redirect` captures and the surface posts AS. */
export interface SlackInstallation {
  teamId: string;
  botToken: string;
  botUserId?: string;
  scopes?: string;
  teamName?: string;
}

/**
 * The per-workspace bot-token store (encrypted at rest, decrypted only here). The Slack surface reads
 * `botToken(teamId)` to build that workspace's WebClient and `botUserId(teamId)` for the per-team echo
 * guard / "bot added" detection. Cached per team, invalidated on upsert/uninstall.
 */
@Injectable()
export class SlackInstallationStore {
  private readonly logger = new Logger(SlackInstallationStore.name);
  private readonly cache = new Map<string, { token: string; botUserId?: string } | null>();

  constructor(
    @InjectRepository(AtlasSlackInstallation, ATLAS_CONNECTION)
    private readonly repo: Repository<AtlasSlackInstallation>,
    private readonly env: EnvService,
  ) {}

  private key(): Buffer {
    return loadSecretsKey(this.env.get('SECRETS_ENCRYPTION_KEY'));
  }

  /** Record (or refresh) a workspace install — encrypts the bot token, clears any prior uninstall. */
  async upsert(install: SlackInstallation): Promise<void> {
    const key = this.key();
    const row =
      (await this.repo.findOne({ where: { team_id: install.teamId } })) ??
      this.repo.create({ team_id: install.teamId });
    row.bot_token_enc = encryptSecret(install.botToken, key);
    row.bot_user_id = install.botUserId ?? null;
    row.scopes = install.scopes ?? null;
    row.team_name = install.teamName ?? null;
    row.uninstalled_at = null;
    await this.repo.save(row);
    this.cache.delete(install.teamId);
    this.logger.log(`stored Slack install for team=${install.teamId} (bot ${install.botUserId ?? '?'})`);
  }

  private async load(teamId: string): Promise<{ token: string; botUserId?: string } | null> {
    const cached = this.cache.get(teamId);
    if (cached !== undefined) return cached;
    const row = await this.repo.findOne({ where: { team_id: teamId } });
    const val =
      row && !row.uninstalled_at
        ? { token: decryptSecret(row.bot_token_enc, this.key()), botUserId: row.bot_user_id ?? undefined }
        : null;
    this.cache.set(teamId, val);
    return val;
  }

  /** The workspace bot token (`xoxb-…`), or undefined if not installed / uninstalled. */
  async botToken(teamId: string): Promise<string | undefined> {
    return (await this.load(teamId))?.token;
  }

  /** The workspace bot user id (for the echo guard + bot-added detection). */
  async botUserId(teamId: string): Promise<string | undefined> {
    return (await this.load(teamId))?.botUserId;
  }

  /** Soft-delete on `app_uninstalled` / `tokens_revoked` — keeps history, stops posting. */
  async markUninstalled(teamId: string): Promise<void> {
    await this.repo.update({ team_id: teamId }, { uninstalled_at: new Date() });
    this.cache.delete(teamId);
    this.logger.log(`marked Slack install uninstalled for team=${teamId}`);
  }
}
