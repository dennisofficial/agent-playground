import type { ClaudeUsageSnapshot } from '@workspace/shared';
import { TimestampedEntity } from '@workspace/shared/schemas';
import { Check, Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { OrganizationEntity } from './organization.entity';

/**
 * Per-org credentials Atlas resolves at point-of-use. Every secret column stores AES-256-GCM ciphertext
 * (`secret-cipher.ts`) — plaintext NEVER lands in a column or a log. Resolved through `CredentialResolver`,
 * which falls back to env when there's no row, so a single-tenant dev box (zero rows) behaves
 * byte-identically to the old env-only code.
 *
 * Composite PK (org_id, scope): `scope='*'` is the org default; a non-`*` scope is a future per-repo
 * override (dormant) — a sentinel rather than a nullable PK column so upserts don't break on Postgres
 * treating NULLs as distinct.
 */
@Entity({ name: 'org_credentials' })
@Index(['org_id'])
@Check('chk_org_credentials_github_auth_mode', "github_auth_mode IN ('pat', 'app')")
export class OrgCredentialsEntity extends TimestampedEntity {
  /** The owning org (FK → organizations). */
  @PrimaryColumn({ type: 'uuid' })
  org_id!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: OrganizationEntity;

  /** Credential scope: '*' = org default; otherwise a repo / token_name override. */
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

  /** The org's Atlas GitHub App installation id — plaintext (not a secret; useless without the platform private key). NULL = App not connected. TypeORM maps bigint→string. */
  @Column({ type: 'bigint', nullable: true })
  github_app_installation_id!: string | null;

  /** The installation's GitHub account login (from GET /app/installations/{id}) — display + audit. NULL until connected. */
  @Column({ type: 'text', nullable: true })
  github_app_installation_account!: string | null;

  /** Which GitHub credential resolves for this org: 'pat' (default) or 'app'. */
  @Column({ type: 'text', default: 'pat' })
  github_auth_mode!: 'pat' | 'app';

  /** Claude subscription OAuth token for the SDK harness — ciphertext (the harness runs subscription-only). */
  @Column({ type: 'text', nullable: true })
  claude_oauth_token_enc!: string | null;

  /** Codex subscription secret (auth.json / token) for the SDK harness — ciphertext. */
  @Column({ type: 'text', nullable: true })
  codex_auth_secret_enc!: string | null;

  /** When the Anthropic key was last validated (1-token probe); null until validated. */
  @Column({ type: 'timestamptz', nullable: true })
  llm_validated_at!: Date | null;

  /** Durable Claude subscription usage snapshot (harvested from rate_limit_event frames). Plaintext — not a secret. */
  @Column({ type: 'jsonb', nullable: true })
  claude_usage_snapshot!: ClaudeUsageSnapshot | null;
}
