import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { OrganizationEntity } from './organization.entity';

@Entity({ name: 'claude_credentials' })
@Index(['org_id'])
@Index('uq_claude_cred_org_email_personal', ['org_id', 'account_email'], {
  unique: true,
  where: `kind = 'personal' AND account_email IS NOT NULL`,
})
export class OrgClaudeCredentialEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  org_id!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: OrganizationEntity;

  @Column({ type: 'text' })
  label!: string;

  @Column({ type: 'text' })
  kind!: 'setup_token' | 'personal';

  @Column({ type: 'text' })
  access_token_enc!: string;

  @Column({ type: 'text', nullable: true })
  refresh_token_enc!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  expires_at!: Date | null;

  @Column({ type: 'text', nullable: true })
  scopes!: string | null;

  @Column({ type: 'text', nullable: true })
  subscription_type!: string | null;

  @Column({ type: 'text', nullable: true })
  account_email!: string | null;

  @Column({ type: 'text', default: 'active' })
  status!: 'active' | 'needs_reauth' | 'error';

  @CreateDateColumn({ type: 'timestamptz', update: false })
  created_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  last_refreshed_at!: Date | null;
}
