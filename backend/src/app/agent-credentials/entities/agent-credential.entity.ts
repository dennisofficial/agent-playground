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
import { TimestampedEntity } from '../../../_lib/database/base.entity';
import { Organization } from '../../org/entities/organization.entity';

/**
 * One agent SDK subscription account for an org — a Claude.ai or ChatGPT/Codex login, multi-account per
 * (org, provider). The runtime token material lives ENCRYPTED in `materialEnc` (provider-specific shape);
 * every other column is denormalized metadata so list / usage / realtime paths never decrypt. Distinct
 * from the key-agnostic secret vault (`org_secrets`), which holds single-valued raw API keys + the PAT.
 */
@Entity({ name: 'agent_credentials' })
@Index(['orgId'])
// One selected account per (org, provider) — replaces the old organizations.selected_claude_credential_id.
@Index('uq_agent_cred_org_provider_selected', ['orgId', 'provider'], {
  unique: true,
  where: 'selected',
})
// Dedupe personal (OAuth) accounts by email within a provider — a re-login updates in place.
@Index('uq_agent_cred_org_provider_email_personal', ['orgId', 'provider', 'accountEmail'], {
  unique: true,
  where: `kind = 'personal' AND account_email IS NOT NULL`,
})
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

/** Injectable DI token / typed alias for the AgentCredential repository. */
export class AgentCredentialRepo extends Repository<AgentCredential> {}
