import { AUTO_MERGE_METHODS, type AutoMergeMethod } from '@workspace/shared';
import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Repository } from 'typeorm';
import { TimestampedEntity } from '../../../_lib/database/base.entity';
import { Organization } from '../../org/entities/organization.entity';

/**
 * A GitHub repository connected under an org — the unit threads/jobs attach to. GitHub-derived
 * fields (`accessOk`, `defaultBranch`, `webhookWarning`) are populated by the GitHub module through
 * the `GithubAccessPort`; until that module lands they default to the unvalidated state.
 *
 * `threadCount` is a denormalized counter (kept at 0 until the threads slice exists) so the realtime
 * row is self-contained — the repo feed is a single-table pg-realtime model with no joins.
 */
@Entity({ name: 'repos' })
@Index(['orgId'])
@Index(['orgId', 'slug'], { unique: true })
export class Repo extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  orgId!: string;

  @ManyToOne(() => Organization, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: Organization;

  /** Human-readable `owner/repo` identity, unique within the org. */
  @Column({ type: 'text' })
  slug!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text' })
  gitUrl!: string;

  @Column({ type: 'text', default: 'main' })
  defaultBranch!: string;

  /** Per-repo feature-branch prefix override; null → neutral built-in default. */
  @Column({ type: 'text', nullable: true })
  branchPrefix!: string | null;

  @Column({ type: 'enum', enum: AUTO_MERGE_METHODS, default: 'squash' })
  defaultAutoMergeMethod!: AutoMergeMethod;

  @Column({ type: 'boolean', default: true })
  defaultAutoMergeDeleteBranch!: boolean;

  // ── GitHub access state (owned by the GitHub module via GithubAccessPort) ──

  @Column({ type: 'boolean', default: false })
  accessOk!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  accessCheckedAt!: Date | null;

  @Column({ type: 'text', nullable: true })
  webhookWarning!: string | null;

  // ── Onboarding (owned by the threads slice; null until then) ──

  @Column({ type: 'uuid', nullable: true })
  onboardingThreadId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  onboardedAt!: Date | null;

  /** Denormalized count of threads on this repo. 0 until the threads slice exists. */
  @Column({ type: 'int', default: 0 })
  threadCount!: number;
}

/** Injectable DI token / typed alias for the Repo repository. */
export class RepoRepo extends Repository<Repo> {}
