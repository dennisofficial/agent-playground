import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';

/**
 * An organization — the top-level tenant in Atlas. Replaces the Slack-era `atlas_teams`/`team_id`
 * dimension: every tenant-scoped `atlas_*` table now carries `org_id` (this row's `id`). Users join an
 * org via `atlas_organization_members`; repos, threads, jobs, credentials, and memory all scope to it.
 */
@Entity({ name: 'atlas_organizations' })
export class Organization extends TimestampedEntity {
  /** App-generated UUID, stored as text (so org_id reference columns stay text and fixtures may use stable ids). */
  @PrimaryColumn({ type: 'text' })
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
}
