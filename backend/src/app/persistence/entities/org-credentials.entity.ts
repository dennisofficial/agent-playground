import type { ClaudeUsageSnapshot } from '@workspace/shared';
import { TimestampedEntity } from '@workspace/shared/schemas';
import { Check, Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { OrganizationEntity } from './organization.entity';

@Entity({ name: 'org_credentials' })
@Index(['org_id'])
@Check('chk_org_credentials_github_auth_mode', "github_auth_mode IN ('pat', 'app')")
export class OrgCredentialsEntity extends TimestampedEntity {
  @PrimaryColumn({ type: 'uuid' })
  org_id!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: OrganizationEntity;

  @PrimaryColumn({ type: 'text', default: '*' })
  scope!: string;

  @Column({ type: 'text', nullable: true })
  anthropic_api_key_enc!: string | null;

  @Column({ type: 'text', nullable: true })
  openai_api_key_enc!: string | null;

  @Column({ type: 'text', nullable: true })
  github_pat_enc!: string | null;

  @Column({ type: 'bigint', nullable: true })
  github_app_installation_id!: string | null;

  @Column({ type: 'text', nullable: true })
  github_app_installation_account!: string | null;

  @Column({ type: 'text', default: 'pat' })
  github_auth_mode!: 'pat' | 'app';

  @Column({ type: 'text', nullable: true })
  claude_oauth_token_enc!: string | null;

  @Column({ type: 'text', nullable: true })
  codex_auth_secret_enc!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  llm_validated_at!: Date | null;

  @Column({ type: 'jsonb', nullable: true })
  claude_usage_snapshot!: ClaudeUsageSnapshot | null;
}
