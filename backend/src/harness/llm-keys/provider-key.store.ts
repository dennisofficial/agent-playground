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
 * `resolve()` is the single decrypt seam — its only caller is LlmReadinessService, which feeds
 * the key into `process.env` for the SDKs (tenant = process), never into anything that renders
 * into chat/LLM context.
 */
export class ProviderKeyStore {
  constructor(
    private readonly repo: Repository<ProviderKeyEntity>,
    private readonly cipher: SecretCipher,
  ) {}

  private async q(sql: string, params: unknown[]): Promise<KeyMetaRow[]> {
    return rawRows<KeyMetaRow>(await this.repo.manager.query(sql, params));
  }

  /** Upsert a provider's key (rotation = same call). */
  async put(provider: LlmProvider, plaintextKey: string): Promise<ProviderKeyMeta> {
    const ciphertext = this.cipher.encrypt(plaintextKey); // throws actionably when key unset
    const rows = await this.q(
      `INSERT INTO provider_keys (provider, key_ciphertext)
       VALUES ($1, $2)
       ON CONFLICT (provider) DO UPDATE SET key_ciphertext = EXCLUDED.key_ciphertext, updated_at = now()
       RETURNING provider, created_at, updated_at`,
      [provider, ciphertext],
    );
    return toMeta(rows[0]);
  }

  /** Providers + metadata only — key_ciphertext is never selected here. */
  async listMeta(): Promise<ProviderKeyMeta[]> {
    const rows = await this.q(
      `SELECT provider, created_at, updated_at FROM provider_keys ORDER BY provider`,
      [],
    );
    return rows.map(toMeta);
  }

  async has(provider: LlmProvider): Promise<boolean> {
    const rows = await this.q(
      `SELECT provider, created_at, updated_at FROM provider_keys WHERE provider = $1`,
      [provider],
    );
    return rows.length > 0;
  }

  async delete(provider: LlmProvider): Promise<void> {
    await this.q(`DELETE FROM provider_keys WHERE provider = $1`, [provider]);
  }

  /** THE decrypt path. Returns undefined when the provider has no stored key. */
  async resolve(provider: LlmProvider): Promise<string | undefined> {
    const rows = rawRows<{ key_ciphertext: string }>(
      await this.repo.manager.query(
        `SELECT key_ciphertext FROM provider_keys WHERE provider = $1`,
        [provider],
      ),
    );
    if (!rows[0]) return undefined;
    return this.cipher.decrypt(rows[0].key_ciphertext);
  }
}
