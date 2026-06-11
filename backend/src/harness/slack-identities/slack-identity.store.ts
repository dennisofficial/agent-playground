import { SlackIdentity as SlackIdentityEntity } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';
import { rawRows, toIso } from '../memory/sql';
import type { SecretCipher } from '../projects/secret-cipher';

/** Identity METADATA — the only shape that ever leaves the store besides `resolve()`. */
export interface SlackIdentityMeta {
  botId: string;
  createdAt: string;
  updatedAt: string;
}

interface IdentityMetaRow {
  bot_id: string;
  created_at: unknown;
  updated_at: unknown;
}

const toMeta = (r: IdentityMetaRow): SlackIdentityMeta => ({
  botId: r.bot_id,
  createdAt: toIso(r.created_at),
  updatedAt: toIso(r.updated_at),
});

/**
 * Per-employee Slack puppet-app bot tokens (the GithubTokenStore pattern). Values are
 * AES-encrypted at rest and WRITE-ONLY: every read path except `resolve()` returns metadata,
 * never ciphertext or plaintext. `resolve()` is the single decrypt seam — its only caller is the
 * slack-app's SlackIdentityRegistry, which hands the token straight to a WebClient constructor,
 * never into logs or chat/LLM context.
 */
export class SlackIdentityStore {
  constructor(
    private readonly repo: Repository<SlackIdentityEntity>,
    private readonly cipher: SecretCipher,
  ) {}

  private async q(sql: string, params: unknown[]): Promise<IdentityMetaRow[]> {
    return rawRows<IdentityMetaRow>(await this.repo.manager.query(sql, params));
  }

  /** Upsert an employee's puppet token (rotation = same call). Pass `slackBotUserId` when known
   * (populated automatically by the OAuth callback via `auth.test()`). */
  async put(
    teamId: string,
    botId: string,
    plaintextToken: string,
    opts?: { slackBotUserId?: string },
  ): Promise<SlackIdentityMeta> {
    const ciphertext = this.cipher.encrypt(plaintextToken); // throws actionably when key unset
    const rows = await this.q(
      `INSERT INTO slack_identities (team_id, bot_id, token_ciphertext, slack_bot_user_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (team_id, bot_id) DO UPDATE SET
         token_ciphertext = EXCLUDED.token_ciphertext,
         slack_bot_user_id = COALESCE(EXCLUDED.slack_bot_user_id, slack_identities.slack_bot_user_id),
         updated_at = now()
       RETURNING bot_id, created_at, updated_at`,
      [teamId, botId, ciphertext, opts?.slackBotUserId ?? null],
    );
    return toMeta(rows[0]);
  }

  /** Resolve the roster bot_id for a Slack user ID (e.g. from `event.user` in
   * `member_joined_channel`). Returns undefined when the user is not a known puppet. */
  async findBotIdBySlackUserId(
    teamId: string,
    slackUserId: string,
  ): Promise<string | undefined> {
    const rows = rawRows<{ bot_id: string }>(
      await this.repo.manager.query(
        `SELECT bot_id FROM slack_identities WHERE team_id = $1 AND slack_bot_user_id = $2 LIMIT 1`,
        [teamId, slackUserId],
      ),
    );
    return rows[0]?.bot_id;
  }

  /** A puppet's Slack bot USER id in a workspace (for joins/invites/mentions), or undefined when
   * unknown — rows PUT manually (admin REST) have it null until backfilled via `auth.test()`. */
  async slackUserIdFor(
    teamId: string,
    botId: string,
  ): Promise<string | undefined> {
    const rows = rawRows<{ slack_bot_user_id: string | null }>(
      await this.repo.manager.query(
        `SELECT slack_bot_user_id FROM slack_identities WHERE team_id = $1 AND bot_id = $2`,
        [teamId, botId],
      ),
    );
    return rows[0]?.slack_bot_user_id ?? undefined;
  }

  /** Backfill a manually-PUT row's bot user id once it's been resolved via `auth.test()`. */
  async setSlackBotUserId(
    teamId: string,
    botId: string,
    slackUserId: string,
  ): Promise<void> {
    await this.q(
      `UPDATE slack_identities SET slack_bot_user_id = $3, updated_at = now()
       WHERE team_id = $1 AND bot_id = $2`,
      [teamId, botId, slackUserId],
    );
  }

  /** A workspace's bot ids + metadata only — token_ciphertext is never selected here. */
  async listMeta(teamId: string): Promise<SlackIdentityMeta[]> {
    const rows = await this.q(
      `SELECT bot_id, created_at, updated_at FROM slack_identities WHERE team_id = $1 ORDER BY bot_id`,
      [teamId],
    );
    return rows.map(toMeta);
  }

  async delete(teamId: string, botId: string): Promise<void> {
    await this.q(
      `DELETE FROM slack_identities WHERE team_id = $1 AND bot_id = $2`,
      [teamId, botId],
    );
  }

  /** THE decrypt path. Returns undefined when the employee has no puppet token in this workspace. */
  async resolve(teamId: string, botId: string): Promise<string | undefined> {
    const rows = rawRows<{ token_ciphertext: string }>(
      await this.repo.manager.query(
        `SELECT token_ciphertext FROM slack_identities WHERE team_id = $1 AND bot_id = $2`,
        [teamId, botId],
      ),
    );
    if (!rows[0]) return undefined;
    return this.cipher.decrypt(rows[0].token_ciphertext);
  }
}
