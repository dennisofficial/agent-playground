import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';
import { DecisionRecordEntity } from './decision-record.entity';
import { OrganizationEntity } from './organization.entity';
import { RepoEntity } from './repo.entity';
import { TicketEntity } from './ticket.entity';

/**
 * One buffered, not-yet-conveyed pipeline milestone (the transient-moment record). `id` is an
 * idempotency key — a build stage emits the same id repeatedly (the driver fires many events per phase),
 * the buffer keeps exactly one. `text` is the passive line shown to the brain; `at` orders the prefix.
 */
export interface PipelineMarker {
  id: string;
  text: string;
  /** ISO-8601 emission time. */
  at: string;
}

/**
 * The PASSIVE pipeline-milestone awareness buffer (see `driver/pipeline-awareness.*`). NOT a turn
 * trigger — milestones append here while the brain is idle and are drained + prepended to the next
 * OPERATOR turn so the brain passively knows where the build stands.
 *  - `markerQueue` — transient named milestones not yet conveyed (deduped by `id`, drained atomically).
 *  - `conveyedStateSig` — signature of the last net-current-state summary already conveyed, so the
 *    state diff only re-states on a real change (null until the first state is conveyed).
 */
export interface ThreadPipelineAwareness {
  markerQueue: PipelineMarker[];
  conveyedStateSig: string | null;
}

/**
 * A THREAD — the unit of work. One intent (a feature or a bugfix) = one sandbox = one worktree = one
 * feature branch = ONE PR. A thread may stay a plain conversation (`status='open'`) or enter the build
 * lifecycle; when it builds, the `sections`/`phases` rows hang directly off it (the former `jobs` layer
 * is folded in here). `decision_records` (1:many — the draft→superseded proposal trail) reference it.
 * `messages` partition by `thread_id`. Threads are isolated for context hygiene — cross-thread coherence
 * is shared memory only, never transcript sharing.
 *
 * `status` (build lifecycle) is a SEPARATE axis from `thread_sandboxes.lifecycle` (container/worktree
 * infra). The branch + PR live HERE (single owner); the sandbox is the disposable workspace.
 */
@Entity({ name: 'threads' })
@Index(['org_id', 'repo_id'])
export class ThreadEntity extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The tenant (FK → organizations.id). */
  @Column({ type: 'uuid' })
  org_id!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: OrganizationEntity;

  /** The repo this thread builds against (FK → repos.id). */
  @Column({ type: 'uuid' })
  repo_id!: string;

  @ManyToOne(() => RepoEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'repo_id' })
  repo?: RepoEntity;

  /** What opened the thread: 'chat' | 'event' | 'control' (operator-created). */
  @Column({ type: 'text' })
  origin!: string;

  /** The surface-native thread coordinate (e.g. the root message ts); null until posted. */
  @Column({ type: 'text', nullable: true })
  surface_thread_ref!: string | null;

  /** Short human-readable label (the feature/notification title). */
  @Column({ type: 'text', nullable: true })
  title!: string | null;

  /** The base branch the build cuts from (operator-picked; null → the repo's default_branch). */
  @Column({ type: 'text', nullable: true })
  base_branch!: string | null;

  /**
   * The ticket this thread was promoted from / works (FK → tickets.id); null for a thread not tied to a
   * ticket. A thread works AT MOST one ticket — enforced 1:1 by a partial unique index
   * (`uq_threads_ticket_id` WHERE ticket_id IS NOT NULL), hand-added in the migration. SET NULL if the
   * ticket is deleted (the thread/PR outlives the board entry).
   */
  @Column({ type: 'uuid', nullable: true })
  ticket_id!: string | null;

  @ManyToOne(() => TicketEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'ticket_id' })
  ticket?: TicketEntity | null;

  // ── build lifecycle (folded in from the former `jobs` table) ───────────────────────────────────────
  /** Build intent: 'feature' (many sections) | 'bugfix' (one). Null until the thread is scoped. */
  @Column({ type: 'text', nullable: true })
  kind!: string | null;

  // 'open' | 'scoping' | 'awaiting_approval' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled'
  @Column({ type: 'text', default: 'open' })
  status!: string;

  /** The locked decision record (FK → decision_records.id); null until the upfront grill produces one. */
  @Column({ type: 'uuid', nullable: true })
  decision_record_id!: string | null;

  @ManyToOne(() => DecisionRecordEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'decision_record_id' })
  decisionRecord?: DecisionRecordEntity | null;

  /** The feature branch all sections stack on; null until the branch is cut. */
  @Column({ type: 'text', nullable: true })
  feature_branch!: string | null;

  /** The opened PR url; null until the PR-tail stage opens one. */
  @Column({ type: 'text', nullable: true })
  pr_url!: string | null;

  /** The opened PR number — what the merge poll queries GitHub with; null until opened. */
  @Column({ type: 'int', nullable: true })
  pr_number!: number | null;

  /**
   * PASSIVE pipeline-milestone awareness buffer — durable per-thread record of build milestones the
   * brain hasn't been told about yet + the watermark of the last pipeline state conveyed. Drained and
   * prepended to the next OPERATOR turn's input (never pushed; never wakes the brain). See the
   * `ThreadPipelineAwareness` doc + `driver/pipeline-awareness.store.ts`.
   */
  @Column({
    type: 'jsonb',
    default: () => `'{"markerQueue":[],"conveyedStateSig":null}'::jsonb`,
  })
  pipeline_awareness!: ThreadPipelineAwareness;
}
