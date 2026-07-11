import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';

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

  /**
   * The org's single active Claude credential (FK → `claude_credentials.id`, ON DELETE SET NULL, enforced
   * in the migration). No `@ManyToOne` relation here on purpose — avoids a circular entity import with
   * `OrgClaudeCredentialEntity`; the plain column + migration FK is enough.
   */
  @Column({ type: 'uuid', nullable: true })
  selected_claude_credential_id!: string | null;
}
