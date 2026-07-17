import type { AutoApproveMode } from '@workspace/shared';
import { TimestampedEntity } from '@workspace/shared/schemas';
import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { OrgClaudeCredentialEntity } from './org-claude-credential.entity';

@Entity({ name: 'organizations' })
export class OrganizationEntity extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'text' })
  name!: string;

  @Index({ unique: true })
  @Column({ type: 'text' })
  slug!: string;

  @Column({ type: 'text', default: 'onboarding' })
  status!: string; // 'onboarding' | 'active' | 'suspended'

  @Column({ type: 'uuid', nullable: true })
  selected_claude_credential_id!: string | null;

  @ManyToOne(() => OrgClaudeCredentialEntity, {
    onDelete: 'SET NULL',
    nullable: true,
  })
  @JoinColumn({
    name: 'selected_claude_credential_id',
    foreignKeyConstraintName: 'fk_organizations_selected_claude_credential_claude_credentials',
  })
  selectedClaudeCredential?: OrgClaudeCredentialEntity | null;

  @Column({ type: 'text', default: 'off' })
  default_auto_approve_mode!: AutoApproveMode;

  @Column({ type: 'boolean', default: false })
  default_auto_merge!: boolean;
}
