import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';

/**
 * Per-tenant credentials Atlas resolves at point-of-use (the multi-tenant layer v1 had, rebuilt into
 * v2). Every secret column stores AES-256-GCM ciphertext (`secret-cipher.ts`) — plaintext NEVER lands
 * in a column or a log. Resolved through `CredentialResolver`, which falls back to env when there's no
 * row, so a single-tenant dev box (zero rows) behaves byte-identically to the old env-only code.
 *
 * Composite PK (team_id, scope): `scope='*'` is the team default; a non-`*` scope is a future
 * per-project override keyed by `atlas_projects.token_name` (the dormant hook) — a sentinel rather than
 * a nullable PK column so upserts don't break on Postgres treating NULLs as distinct.
 */
@Entity({ name: 'atlas_tenant_credentials' })
@Index(['team_id'])
export class AtlasTenantCredentials extends TimestampedEntity {
  /** The tenant (Slack team id) these credentials belong to (FK → atlas_teams). */
  @PrimaryColumn({ type: 'text' })
  team_id!: string;

  /** Credential scope: '*' = team default; otherwise a project_id / token_name override. */
  @PrimaryColumn({ type: 'text', default: '*' })
  scope!: string;

  /** Anthropic API key (LLM brain/gate/planner) — ciphertext. */
  @Column({ type: 'text', nullable: true })
  anthropic_api_key_enc!: string | null;

  /** OpenAI API key (memory embeddings) — ciphertext. */
  @Column({ type: 'text', nullable: true })
  openai_api_key_enc!: string | null;

  /** GitHub PAT (clone + push + PR) — ciphertext. */
  @Column({ type: 'text', nullable: true })
  github_pat_enc!: string | null;

  /** Coding-engine auth posture: 'api_key' (uses the Anthropic key) | 'subscription'. */
  @Column({ type: 'text', default: 'api_key' })
  engine_auth_mode!: string;

  /** Subscription secret (Claude OAuth token / Codex auth.json) — ciphertext, only for subscription mode. */
  @Column({ type: 'text', nullable: true })
  engine_auth_secret_enc!: string | null;
}
