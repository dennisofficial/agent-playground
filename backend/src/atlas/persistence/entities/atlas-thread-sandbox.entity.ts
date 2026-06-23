import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';

/**
 * The per-thread sandbox association — one row per thread. This row is the DURABLE record of the
 * thread's work area: its worktree + feature branch + engine session. The container is a DISPOSABLE
 * cache spun up against the worktree — reaped when idle, re-attached on demand — so `container_id` is
 * transient and null whenever the thread is `detached`.
 *
 * Lifecycle:
 *  - `provisioning` — worktree is being cut
 *  - `attached`     — worktree + branch are durable AND a live container is bound (`container_id` set);
 *                     turns exec directly
 *  - `detached`     — worktree + branch + session are durable but NO container (reaped/crashed);
 *                     the next turn re-attaches a fresh container (with a "sandbox was reset" notice)
 *  - `closed`       — terminal: worktree removed + container gone (PR merged / thread closed)
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

  /** 'provisioning' | 'attached' | 'detached' | 'closed' */
  @Column({ type: 'text', default: 'provisioning' })
  lifecycle!: string;

  /**
   * The Claude Agent SDK session id for the per-thread conversational session (the AgentSessionManager
   * chat brain). Persisted so the session can be resumed across host restarts. Null before the first
   * conversational turn.
   */
  @Column({ type: 'text', nullable: true })
  session_id!: string | null;

  /**
   * Last time a turn ran for this thread (bumped at turn start). Drives the idle reaper + LRU eviction:
   * an `attached` row idle past `ATLAS_SANDBOX_IDLE_TTL_MS` is reaped to `detached`. Null until the
   * first turn.
   */
  @Column({ type: 'timestamptz', nullable: true })
  last_active_at!: Date | null;

  /** The thread's PR url, recorded when the build opens its PR (so the merge poll can watch it). */
  @Column({ type: 'text', nullable: true })
  pr_url!: string | null;

  /** The thread's PR number, recorded alongside `pr_url` — what the merge poll queries GitHub with. */
  @Column({ type: 'int', nullable: true })
  pr_number!: number | null;
}
