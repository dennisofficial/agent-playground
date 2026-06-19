import { ProviderKey as ProviderKeyEntity } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';
import { rawRows, toIso } from '../memory/sql';
import type { SecretCipher } from '../projects/secret-cipher';
import {
  isEngineAuthMode,
  type EngineAuthMode,
  type LlmProvider,
  type ProviderCredential,
  type ProviderKeyMeta,
} from './llm-key.types';

interface KeyMetaRow {
  provider: LlmProvider;
  engine_auth_mode: string | null;
  has_api_key: boolean;
  has_subscription: boolean;
  created_at: unknown;
  updated_at: unknown;
}

const toMode = (v: string | null | undefined): EngineAuthMode =>
  v && isEngineAuthMode(v) ? v : 'api_key';

const toMeta = (r: KeyMetaRow): ProviderKeyMeta => ({
  provider: r.provider,
  engineAuthMode: toMode(r.engine_auth_mode),
  hasApiKey: r.has_api_key,
  hasSubscription: r.has_subscription,
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

  // Non-secret metadata projection, reused by every write/list path (never selects ciphertext).
  private static readonly META_RETURNING = `provider, engine_auth_mode,
       (key_ciphertext IS NOT NULL) AS has_api_key,
       (subscription_ciphertext IS NOT NULL) AS has_subscription,
       created_at, updated_at`;

  /** Upsert a provider's API key for a workspace (rotation = same call). Leaves the subscription
   * credential / engine_auth_mode untouched. */
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
       RETURNING ${ProviderKeyStore.META_RETURNING}`,
      [teamId, provider, ciphertext],
    );
    return toMeta(rows[0]);
  }

  /** Set a provider's ENGINE auth mode and (optionally) its subscription credential, WITHOUT
   * touching the API key (which still funds chat/gate/embeddings). Passing `secret=undefined` keeps
   * any stored secret — e.g. to flip the mode back to 'api_key' without discarding the credential. */
  async putSubscription(
    teamId: string,
    provider: LlmProvider,
    mode: EngineAuthMode,
    secret?: string,
  ): Promise<ProviderKeyMeta> {
    const ciphertext = secret !== undefined ? this.cipher.encrypt(secret) : null;
    const rows = await this.q(
      `INSERT INTO provider_keys (team_id, provider, engine_auth_mode, subscription_ciphertext)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (team_id, provider) DO UPDATE SET
         engine_auth_mode = EXCLUDED.engine_auth_mode,
         subscription_ciphertext = COALESCE(EXCLUDED.subscription_ciphertext, provider_keys.subscription_ciphertext),
         updated_at = now()
       RETURNING ${ProviderKeyStore.META_RETURNING}`,
      [teamId, provider, mode, ciphertext],
    );
    return toMeta(rows[0]);
  }

  /** Providers + metadata only (for one workspace) — no ciphertext is ever selected here. */
  async listMeta(teamId: string): Promise<ProviderKeyMeta[]> {
    const rows = await this.q(
      `SELECT ${ProviderKeyStore.META_RETURNING} FROM provider_keys WHERE team_id = $1 ORDER BY provider`,
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

  /** THE decrypt path for the full credential (API key + engine auth mode + subscription secret).
   * Returns undefined when the workspace has no row for the provider. The single seam that decrypts. */
  async resolveCredential(
    teamId: string,
    provider: LlmProvider,
  ): Promise<ProviderCredential | undefined> {
    const rows = rawRows<{
      key_ciphertext: string | null;
      engine_auth_mode: string | null;
      subscription_ciphertext: string | null;
    }>(
      await this.repo.manager.query(
        `SELECT key_ciphertext, engine_auth_mode, subscription_ciphertext
         FROM provider_keys WHERE team_id = $1 AND provider = $2`,
        [teamId, provider],
      ),
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      apiKey: row.key_ciphertext
        ? this.cipher.decrypt(row.key_ciphertext)
        : undefined,
      engineAuthMode: toMode(row.engine_auth_mode),
      subscriptionSecret: row.subscription_ciphertext
        ? this.cipher.decrypt(row.subscription_ciphertext)
        : undefined,
    };
  }

  /** The API key for a provider (chat/gate/embeddings + 'api_key'-mode engine turns), or undefined. */
  async resolve(
    teamId: string,
    provider: LlmProvider,
  ): Promise<string | undefined> {
    return (await this.resolveCredential(teamId, provider))?.apiKey;
  }
}
