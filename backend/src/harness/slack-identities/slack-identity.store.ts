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

  /** Upsert an employee's puppet token (rotation = same call). */
  async put(
    teamId: string,
    botId: string,
    plaintextToken: string,
  ): Promise<SlackIdentityMeta> {
    const ciphertext = this.cipher.encrypt(plaintextToken); // throws actionably when key unset
    const rows = await this.q(
      `INSERT INTO slack_identities (team_id, bot_id, token_ciphertext)
       VALUES ($1, $2, $3)
       ON CONFLICT (team_id, bot_id) DO UPDATE SET token_ciphertext = EXCLUDED.token_ciphertext, updated_at = now()
       RETURNING bot_id, created_at, updated_at`,
      [teamId, botId, ciphertext],
    );
    return toMeta(rows[0]);
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
