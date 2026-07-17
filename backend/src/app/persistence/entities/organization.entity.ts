import type { AutoApproveMode } from '@workspace/shared';
import { TimestampedEntity } from '@workspace/shared/schemas';
import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { OrgClaudeCredentialEntity } from './org-claude-credential.entity';

/**
 * An organization — the top-level tenant in Atlas. Replaces the Slack-era `atlas_teams`/`team_id`
 * dimension: every tenant-scoped `app` table now carries `org_id` (this row's `id`, a real `uuid`).
 * Users join an org via `organization_members`; repos, threads, credentials, and memory all scope to it.
 */
@Entity({ name: 'organizations' })
export class OrganizationEntity extends TimestampedEntity {
  /** DB-generated UUID. Fixtures may still insert explicit (stable) uuids for idempotent seeds. */
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Human-readable name (as the operator typed it). */
  @Column({ type: 'text' })
  name!: string;

  /** URL-safe unique handle derived from the name. */
  @Index({ unique: true })
  @Column({ type: 'text' })
  slug!: string;

  /** Onboarding lifecycle: 'onboarding' until credentials + a validated repo are connected. */
  @Column({ type: 'text', default: 'onboarding' })
  status!: string; // 'onboarding' | 'active' | 'suspended'

  /** The org's single active Claude credential (FK → `claude_credentials.id`, ON DELETE SET NULL). */
  @Column({ type: 'uuid', nullable: true })
  selected_claude_credential_id!: string | null;

  /**
   * `foreignKeyConstraintName` is explicit because the naming-strategy-computed name
   * (`fk_organizations_selected_claude_credential_id_claude_credentials`, 65 chars) exceeds Postgres's
   * 63-char identifier limit — Postgres silently truncates it at every reference, which would drift
   * forever against TypeORM's (untruncated) computed name on every `generate`.
   */
  @ManyToOne(() => OrgClaudeCredentialEntity, {
    onDelete: 'SET NULL',
    nullable: true,
  })
  @JoinColumn({
    name: 'selected_claude_credential_id',
    foreignKeyConstraintName: 'fk_organizations_selected_claude_credential_claude_credentials',
  })
  selectedClaudeCredential?: OrgClaudeCredentialEntity | null;

  /** Org DEFAULT auto-approve mode a new job inherits at creation (see createJob). 'off' until an owner sets it. */
  @Column({ type: 'text', default: 'off' })
  default_auto_approve_mode!: AutoApproveMode;

  /** Org DEFAULT auto-merge a new job inherits at creation. false until an owner sets it. */
  @Column({ type: 'boolean', default: false })
  default_auto_merge!: boolean;
}
