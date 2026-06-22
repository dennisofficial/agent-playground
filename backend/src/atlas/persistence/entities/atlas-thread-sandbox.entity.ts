import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';

/**
 * The per-thread sandbox association — one row per thread that has been provisioned with a sandbox.
 * Tracks the container (docker mode) or worktree (local mode), the base + feature branches, and the
 * lifecycle status so the driver can reuse the sandbox instead of creating a per-feature one.
 *
 * Lifecycle:
 *  - `provisioning` — sandbox is being created on the base branch
 *  - `ready`        — sandbox is live on the base branch; planning turns may start
 *  - `branched`     — feature branch has been cut in-place; build turns use this sandbox
 *  - `teardown`     — tear-down has been requested
 */
@Entity({ name: 'atlas_thread_sandboxes' })
@Index(['team_id', 'thread_id'], { unique: true })
export class AtlasThreadSandbox extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The tenant (Slack team id). */
  @Column({ type: 'text' })
  team_id!: string;

  /** FK → atlas_threads.id */
  @Column({ type: 'uuid' })
  thread_id!: string;

  /** The project this sandbox is for (FK → atlas_projects). */
  @Column({ type: 'text' })
  project_id!: string;

  /** The base branch the sandbox was provisioned on (origin HEAD at thread creation). */
  @Column({ type: 'text' })
  base_branch!: string;

  /**
   * The feature branch cut in-place on approval (`atlas/<kind>-<jobId-prefix>`). Null until
   * branch-switch occurs.
   */
  @Column({ type: 'text', nullable: true })
  feature_branch!: string | null;

  /** Absolute path to the worktree checkout (the engine's cwd, also bind-mounted in docker mode). */
  @Column({ type: 'text' })
  worktree_path!: string;

  /**
   * Docker container id (docker mode only). In local mode this is null — the engine runs in-process
   * against the worktree.
   */
  @Column({ type: 'text', nullable: true })
  container_id!: string | null;

  /** 'provisioning' | 'ready' | 'branched' | 'teardown' */
  @Column({ type: 'text', default: 'provisioning' })
  lifecycle!: string;
}
