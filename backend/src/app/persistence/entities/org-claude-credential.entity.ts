import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { OrganizationEntity } from './organization.entity';

/**
 * A LIST of stored Claude credentials per org (unlike the singleton `org_credentials` row) — one row per
 * setup-token or personal OAuth login the org has connected. Every `*_enc` column is AES-256-GCM ciphertext
 * (`secret-cipher.ts`); plaintext NEVER lands in a column or a log. `setup_token` rows have no refresh token
 * or expiry (a static token); `personal` rows carry a refresh token + expiry and are kept fresh by
 * `ClaudeCredentialStore.advanceClaudeCredential`. Which row is active for an org lives on
 * `organizations.selected_claude_credential_id`, not here.
 */
@Entity({ name: 'claude_credentials' })
@Index(['org_id'])
@Index('uq_claude_cred_org_email_personal', ['org_id', 'account_email'], {
  unique: true,
  where: `kind = 'personal' AND account_email IS NOT NULL`,
})
export class OrgClaudeCredentialEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The owning org (FK → organizations, ON DELETE CASCADE). */
  @Column({ type: 'uuid' })
  org_id!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: OrganizationEntity;

  /** Human label shown in settings (e.g. "Dennis personal", "CI setup-token"). */
  @Column({ type: 'text' })
  label!: string;

  @Column({ type: 'text' })
  kind!: 'setup_token' | 'personal';

  /** The setup-token, or the personal access token — ciphertext (AES-256-GCM via `secret-cipher.ts`). */
  @Column({ type: 'text' })
  access_token_enc!: string;

  /** Personal only — ciphertext; setup_token rows have no refresh token. */
  @Column({ type: 'text', nullable: true })
  refresh_token_enc!: string | null;

  /** Personal only — the access-token expiry (`claudeAiOauth.expiresAt`). */
  @Column({ type: 'timestamptz', nullable: true })
  expires_at!: Date | null;

  /** Space-joined scopes (e.g. `user:inference user:profile`). */
  @Column({ type: 'text', nullable: true })
  scopes!: string | null;

  /** `claudeAiOauth.subscriptionType` (e.g. `max`). */
  @Column({ type: 'text', nullable: true })
  subscription_type!: string | null;

  /** From the token-exchange response `account.email_address` — display only. */
  @Column({ type: 'text', nullable: true })
  account_email!: string | null;

  @Column({ type: 'text', default: 'active' })
  status!: 'active' | 'needs_reauth' | 'error';

  @CreateDateColumn({ type: 'timestamptz', update: false })
  created_at!: Date;

  /** Stamped by `advanceClaudeCredential` on a real rotation. */
  @Column({ type: 'timestamptz', nullable: true })
  last_refreshed_at!: Date | null;
}
