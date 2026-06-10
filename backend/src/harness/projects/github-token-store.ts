import { GithubToken as GithubTokenEntity } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';
import { rawRows, toIso } from '../memory/sql';
import type { GithubTokenMeta } from './project.types';
import type { ProjectStore } from './project-store';
import type { SecretCipher } from './secret-cipher';

interface TokenMetaRow {
  name: string;
  is_default: boolean;
  created_at: unknown;
  updated_at: unknown;
}

const toMeta = (r: TokenMetaRow): GithubTokenMeta => ({
  name: r.name,
  isDefault: r.is_default,
  createdAt: toIso(r.created_at),
  updatedAt: toIso(r.updated_at),
});

/**
 * The named GitHub token store. Values are AES-encrypted at rest and WRITE-ONLY: every read path
 * except `resolve()` returns metadata, never ciphertext or plaintext. `resolve()` is the single
 * decrypt seam — its callers are the worktree remote sync and open_pr, which pass the token into
 * git env / an Authorization header only, never into anything that renders into chat/LLM context.
 */
export class GithubTokenStore {
  constructor(
    private readonly repo: Repository<GithubTokenEntity>,
    private readonly cipher: SecretCipher,
    private readonly projects: ProjectStore,
  ) {}

  private async q(sql: string, params: unknown[]): Promise<TokenMetaRow[]> {
    return rawRows<TokenMetaRow>(await this.repo.manager.query(sql, params));
  }

  /** Upsert a token by name. The first token ever stored becomes the default automatically. */
  async put(name: string, plaintextToken: string, makeDefault?: boolean): Promise<GithubTokenMeta> {
    const ciphertext = this.cipher.encrypt(plaintextToken); // throws actionably when key unset
    const countRows = rawRows<{ n: number }>(
      await this.repo.manager.query(`SELECT count(*)::int AS n FROM github_tokens`),
    );
    const isFirst = Number(countRows[0]?.n ?? 0) === 0;
    const rows = await this.q(
      `INSERT INTO github_tokens (name, token_ciphertext, is_default)
       VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET token_ciphertext = EXCLUDED.token_ciphertext, updated_at = now()
       RETURNING name, is_default, created_at, updated_at`,
      [name, ciphertext, isFirst],
    );
    if (makeDefault && !rows[0].is_default) {
      await this.setDefault(name);
      return (await this.meta(name))!;
    }
    return toMeta(rows[0]);
  }

  private async meta(name: string): Promise<GithubTokenMeta | undefined> {
    const rows = await this.q(
      `SELECT name, is_default, created_at, updated_at FROM github_tokens WHERE name = $1`,
      [name],
    );
    return rows[0] ? toMeta(rows[0]) : undefined;
  }

  /** Names + metadata only — token_ciphertext is never selected here. */
  async listMeta(): Promise<GithubTokenMeta[]> {
    const rows = await this.q(
      `SELECT name, is_default, created_at, updated_at FROM github_tokens ORDER BY name`,
      [],
    );
    return rows.map(toMeta);
  }

  /** Single-default swap. Two statements in one transaction — a one-statement `is_default =
   * (name = $1)` can transiently hold two TRUE index entries mid-update, and the partial unique
   * index (the backstop) is checked per row, so it must be clear-then-set. */
  async setDefault(name: string): Promise<void> {
    const existing = await this.meta(name);
    if (!existing) throw new Error(`No token named "${name}".`);
    await this.repo.manager.transaction(async (tx) => {
      await tx.query(
        `UPDATE github_tokens SET is_default = false, updated_at = now() WHERE is_default AND name <> $1`,
        [name],
      );
      await tx.query(
        `UPDATE github_tokens SET is_default = true, updated_at = now() WHERE name = $1 AND NOT is_default`,
        [name],
      );
    });
  }

  /** Refuses while any project references the token by name. */
  async delete(name: string): Promise<void> {
    const refs = await this.projects.countReferencingToken(name);
    if (refs > 0) {
      throw new Error(`Token "${name}" is referenced by ${refs} project(s) — repoint them first.`);
    }
    await this.q(`DELETE FROM github_tokens WHERE name = $1`, [name]);
  }

  /**
   * THE decrypt path: the named token, or the default when no name is given. Returns undefined
   * when neither exists (callers degrade to tokenless/refusal).
   */
  async resolve(tokenName?: string | null): Promise<{ name: string; token: string } | undefined> {
    const rows = rawRows<{ name: string; token_ciphertext: string }>(
      await this.repo.manager.query(
        tokenName
          ? `SELECT name, token_ciphertext FROM github_tokens WHERE name = $1`
          : `SELECT name, token_ciphertext FROM github_tokens WHERE is_default`,
        tokenName ? [tokenName] : [],
      ),
    );
    if (!rows[0]) return undefined;
    return { name: rows[0].name, token: this.cipher.decrypt(rows[0].token_ciphertext) };
  }
}
