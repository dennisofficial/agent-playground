import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';
import { OrganizationEntity } from './organization.entity';
import { RepoEntity } from './repo.entity';
import { JobEntity } from './job.entity';

/**
 * The per-thread sandbox — one row per thread (the disposable INFRA for the thread's build). The
 * worktree + engine session are durable; the container is a disposable cache spun up against the
 * worktree (reaped when idle, re-attached on demand) so `container_id` is transient and null whenever
 * the thread is `detached`. The branch + PR live on the THREAD now (single owner); this row is purely
 * the physical workspace.
 *
 * Lifecycle:
 *  - `provisioning` — worktree is being cut
 *  - `attached`     — worktree durable AND a live container is bound (`container_id` set); turns exec directly
 *  - `detached`     — worktree + session durable but NO container (reaped/crashed); next turn re-attaches
 *  - `closed`       — terminal: worktree removed + container gone (PR merged / thread closed)
 */
@Entity({ name: 'job_sandboxes' })
@Index(['job_id'], { unique: true })
export class JobSandboxEntity extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The tenant (FK → organizations.id). */
  @Column({ type: 'uuid' })
  org_id!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: OrganizationEntity;

  /** The thread this sandbox serves (FK → threads.id; 1:1). */
  @Column({ type: 'uuid' })
  job_id!: string;

  @ManyToOne(() => JobEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'job_id' })
  thread?: JobEntity;

  /** The repo this sandbox is for (FK → repos.id). */
  @Column({ type: 'uuid' })
  repo_id!: string;

  @ManyToOne(() => RepoEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'repo_id' })
  repo?: RepoEntity;

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
   * COMPACTION SEED — a durable, one-shot handoff summary stashed when the brain session is compacted
   * (e.g. on `dispatch_build`, once the plan is durable). Compaction summarizes the fat session, then
   * NULLs `session_id` (abandoning the heavy transcript) and stores the lean summary here. The next brain
   * turn folds this into its prompt and starts a FRESH session with it (see the fold in `runChatTurnInner`),
   * then clears it the instant that fresh session is born. Best-effort: if lost to a crash, the fresh
   * session re-orients from durable state (`/context`, `.atlas/decisions`) on its own. Null when there's
   * no pending compaction.
   */
  @Column({ type: 'text', nullable: true })
  pending_compaction_seed!: string | null;

  /**
   * The SDK session id compaction is ABANDONING (set at the start of the summary turn, before the engine
   * runs). While set, `TurnRecoveryService` must NOT surface that session's transcript — its tail is the
   * internal compaction summary, which would otherwise leak into the operator log as a `chat` message. Held
   * through a successful reseed (which nulls `session_id` but keeps this) until the FRESH session is born
   * (the eager session-id persist clears it alongside `pending_compaction_seed`). If `session_id` still
   * points at this value after a restart, the reseed never committed — the boot reconciler completes it.
   * Null when no compaction is in flight.
   */
  @Column({ type: 'text', nullable: true })
  compacting_session_id!: string | null;

  /**
   * Last time a turn ran for this thread (bumped at turn start). Drives the idle reaper + LRU eviction:
   * an `attached` row idle past `SANDBOX_IDLE_TTL_MS` is reaped to `detached`. Null until the first turn.
   */
  @Column({ type: 'timestamptz', nullable: true })
  last_active_at!: Date | null;

  /**
   * Signature of the last worktree HYDRATION (hash of `.atlas/worktree.json` + the resolved secret
   * versions + seed source mtimes). `ensureContainer` re-runs the hydrator only when this is stale, so a
   * rotated secret or changed manifest re-applies on the next attach without re-decrypting every turn.
   * Null before the first hydration. Thread sandboxes only — non-thread (gate/legacy) paths re-hydrate
   * statelessly each attach.
   */
  @Column({ type: 'text', nullable: true })
  hydration_sig!: string | null;
}
