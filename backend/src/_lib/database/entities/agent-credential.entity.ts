import { TimestampedEntity } from '@lib/database/base.entity';
import type { AtlasClaims } from '@lib/rls/atlas-claims';
import { Rls } from '@workspace/nestjs-rls';
import type { AccountUsageSnapshot } from '@workspace/shared';
import { EAgentCredentialKind, EAgentCredentialStatus, EAgentProvider } from '@workspace/shared';
import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Repository,
} from 'typeorm';
import { Organization } from './organization.entity';

@Entity({ name: 'agent_credentials' })
@Index(['orgId'])
@Index(['orgId', 'provider'], {
  unique: true,
  where: 'selected',
})
@Index(['orgId', 'provider', 'accountEmail'], {
  unique: true,
  where: `kind = 'personal' AND account_email IS NOT NULL`,
})
@Rls<AgentCredential, AtlasClaims>((c, action) => ({
  orgId: { $in: action === 'read' ? c.orgIds : c.ownerOrgIds },
}))
export class AgentCredential extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  orgId!: string;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: Organization;

  @Column({ type: 'enum', enum: EAgentProvider })
  provider!: EAgentProvider;

  @Column({ type: 'enum', enum: EAgentCredentialKind })
  kind!: EAgentCredentialKind;

  @Column({ type: 'text' })
  label!: string;

  @Column({ type: 'text', nullable: true })
  accountEmail!: string | null;

  /** Raw subscription plan (e.g. "max"), source of the "Max plan" badge. */
  @Column({ type: 'text', nullable: true })
  subscriptionType!: string | null;

  @Column({ type: 'enum', enum: EAgentCredentialStatus, default: EAgentCredentialStatus.ACTIVE })
  status!: EAgentCredentialStatus;

  @Column({ type: 'text', nullable: true })
  scopes!: string | null;

  /**
   * AES-256-GCM blob of the runtime credential. Decrypted shape depends on (provider, kind):
   * Claude personal → `{claudeAiOauth:{accessToken,refreshToken,expiresAt,scopes,subscriptionType}}`;
   * Claude setup_token → the raw `sk-ant-oat…` string; Codex → the full `~/.codex/auth.json` blob
   * (`{tokens:{id_token,access_token,refresh_token,account_id}, OPENAI_API_KEY?, last_refresh}`).
   * Never leaves the backend — excluded from the realtime mapRow and every view.
   */
  @Column({ type: 'text' })
  materialEnc!: string;

  /** Denormalized access-token expiry for the keepalive scan; null for non-expiring setup-tokens. */
  @Column({ type: 'timestamptz', nullable: true })
  expiresAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastRefreshedAt!: Date | null;

  @Column({ type: 'boolean', default: false })
  selected!: boolean;

  /** Per-account subscription usage windows (util% + resets). Plain literal default null (no fn-default). */
  @Column({ type: 'jsonb', nullable: true })
  usageSnapshot!: AccountUsageSnapshot | null;
}

export class AgentCredentialRepo extends Repository<AgentCredential> {}
