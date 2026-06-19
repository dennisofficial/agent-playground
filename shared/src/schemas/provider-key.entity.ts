import { Column, Entity, PrimaryColumn } from 'typeorm';
import { TimestampedEntity } from './classes/base.entity';

/**
 * A tenant-supplied LLM provider credential ('anthropic' | 'openai'). VALUES are AES-256-GCM
 * encrypted at rest (`v1:<iv>:<tag>:<ct>`, key from SECRETS_ENCRYPTION_KEY env) and WRITE-ONLY
 * through the admin API — list/read paths return provider + metadata, never ciphertext or
 * plaintext. Keys arrive at RUNTIME (the tenant exists before its keys): the harness boots
 * key-less in pending-keys mode and LlmReadinessService lights the engines up when both land.
 *
 * Two credentials can coexist per row: the metered API key (`key_ciphertext`, used for chat / gate
 * / embeddings AND engine turns by default) and an OPTIONAL subscription credential
 * (`subscription_ciphertext`) used for the coding-ENGINE turns when `engine_auth_mode` is
 * 'subscription' — a Claude `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or a Codex
 * `auth.json` blob (from `codex login`). Subscription auth is ADDITIVE: chat/gate/embeddings always
 * use the API key, so a subscription workspace still supplies one.
 */
@Entity({ name: 'provider_keys' })
export class ProviderKey extends TimestampedEntity {
  /** The tenant (Slack team id) these keys belong to — part of the PK; each workspace brings its
   * own Anthropic/OpenAI keys (billing separation is per key). */
  @PrimaryColumn({ type: 'text' })
  team_id!: string;

  @PrimaryColumn({ type: 'text' })
  provider!: string;

  /** The metered API key, encrypted. Nullable: a workspace can register a subscription credential
   * (or rely on the process-env dev fallback) before/without storing an API key here. */
  @Column({ type: 'text', nullable: true })
  key_ciphertext!: string | null;

  /** Which credential funds this provider's ENGINE (session) turns: 'api_key' (default) bills the
   * API key per token; 'subscription' uses `subscription_ciphertext`. Chat/gate/embeddings ignore
   * this and always use the API key. */
  @Column({ type: 'text', default: 'api_key' })
  engine_auth_mode!: string;

  /** The OPTIONAL subscription credential, encrypted (Claude OAuth token or Codex auth.json blob).
   * Only consulted when `engine_auth_mode` is 'subscription'. */
  @Column({ type: 'text', nullable: true })
  subscription_ciphertext!: string | null;
}
