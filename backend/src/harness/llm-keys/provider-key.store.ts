import { ProviderKey as ProviderKeyEntity } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';
import { rawRows, toIso } from '../memory/sql';
import type { SecretCipher } from '../projects/secret-cipher';
import type { LlmProvider, ProviderKeyMeta } from './llm-key.types';

interface KeyMetaRow {
  provider: LlmProvider;
  created_at: unknown;
  updated_at: unknown;
}

const toMeta = (r: KeyMetaRow): ProviderKeyMeta => ({
  provider: r.provider,
  createdAt: toIso(r.created_at),
  updatedAt: toIso(r.updated_at),
});

/**
 * The tenant LLM key store (the GithubTokenStore pattern). Values are AES-encrypted at rest and
 * WRITE-ONLY: every read path except `resolve()` returns metadata, never ciphertext or plaintext.
 * Every row is scoped to a `team_id` (one shared DB, many workspaces); `resolve()` is the single
 * decrypt seam — its caller (TenantCredentialService) builds per-tenant SDK clients from the key,
 * never renders it into chat/LLM context.
 */
export class ProviderKeyStore {
  constructor(
    private readonly repo: Repository<ProviderKeyEntity>,
    private readonly cipher: SecretCipher,
  ) {}

  private async q(sql: string, params: unknown[]): Promise<KeyMetaRow[]> {
    return rawRows<KeyMetaRow>(await this.repo.manager.query(sql, params));
  }

  /** Upsert a provider's key for a workspace (rotation = same call). */
  async put(
    teamId: string,
    provider: LlmProvider,
    plaintextKey: string,
  ): Promise<ProviderKeyMeta> {
    const ciphertext = this.cipher.encrypt(plaintextKey); // throws actionably when key unset
    const rows = await this.q(
      `INSERT INTO provider_keys (team_id, provider, key_ciphertext)
       VALUES ($1, $2, $3)
       ON CONFLICT (team_id, provider) DO UPDATE SET key_ciphertext = EXCLUDED.key_ciphertext, updated_at = now()
       RETURNING provider, created_at, updated_at`,
      [teamId, provider, ciphertext],
    );
    return toMeta(rows[0]);
  }

  /** Providers + metadata only (for one workspace) — key_ciphertext is never selected here. */
  async listMeta(teamId: string): Promise<ProviderKeyMeta[]> {
    const rows = await this.q(
      `SELECT provider, created_at, updated_at FROM provider_keys WHERE team_id = $1 ORDER BY provider`,
      [teamId],
    );
    return rows.map(toMeta);
  }

  async has(teamId: string, provider: LlmProvider): Promise<boolean> {
    const rows = await this.q(
      `SELECT provider, created_at, updated_at FROM provider_keys WHERE team_id = $1 AND provider = $2`,
      [teamId, provider],
    );
    return rows.length > 0;
  }

  async delete(teamId: string, provider: LlmProvider): Promise<void> {
    await this.q(
      `DELETE FROM provider_keys WHERE team_id = $1 AND provider = $2`,
      [teamId, provider],
    );
  }

  /** THE decrypt path. Returns undefined when the workspace has no stored key for the provider. */
  async resolve(
    teamId: string,
    provider: LlmProvider,
  ): Promise<string | undefined> {
    const rows = rawRows<{ key_ciphertext: string }>(
      await this.repo.manager.query(
        `SELECT key_ciphertext FROM provider_keys WHERE team_id = $1 AND provider = $2`,
        [teamId, provider],
      ),
    );
    if (!rows[0]) return undefined;
    return this.cipher.decrypt(rows[0].key_ciphertext);
  }
}
