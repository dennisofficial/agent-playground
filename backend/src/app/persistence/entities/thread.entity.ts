import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';
import { OrganizationEntity } from './organization.entity';
import { JobEntity } from './job.entity';

/**
 * One THREAD of a thread's build — a SCOPE-TYPED slice (backend/frontend/docs/testing/analytics/infra)
 * that becomes a set of steps and is reviewed by agents matched to its `type`. Threads stack on the
 * thread's one feature branch and run sequentially (ORDER BY ordinal). `status` is the explicit,
 * resumable cursor. Gap-numbered ordinals so a re-plan can splice without renumbering.
 */
@Entity({ name: 'threads' })
@Index(['job_id'])
@Unique(['job_id', 'ordinal'])
export class ThreadEntity extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The owning thread (FK → threads.id). */
  @Column({ type: 'uuid' })
  job_id!: string;

  @ManyToOne(() => JobEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'job_id' })
  thread?: JobEntity;

  /** The tenant (org id) — denormalized for org-scoped queries (FK → organizations.id). */
  @Column({ type: 'uuid' })
  org_id!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: OrganizationEntity;

  /** Execution order within the thread, GAP-NUMBERED (10, 20, 30…) so a re-plan can splice. */
  @Column({ type: 'int' })
  ordinal!: number;

  /** The one-line brief (title) from the upfront thread list. */
  @Column({ type: 'text' })
  brief!: string;

  /**
   * The scope TYPE of this thread (backend/frontend/docs/testing/analytics/infra/…) — selects the
   * review agents that check it. A fixed vocabulary (THREAD_TYPES) with an allow-other escape hatch;
   * defaults to 'general' for arg-less callers (bugfix/direct build).
   */
  @Column({ type: 'text', default: 'general' })
  type!: string;

  /** The detailed plan once authored/generated; null while pending. Steps LOCK once planned. */
  @Column({ type: 'text', nullable: true })
  plan!: string | null;

  /** The prior thread's handoff note threaded into this thread's plan prompt. */
  @Column({ type: 'text', nullable: true })
  handoff_in!: string | null;

  /** This thread's handoff note for the next thread; null until done. */
  @Column({ type: 'text', nullable: true })
  handoff_out!: string | null;

  // 'pending' | 'planning' | 'reviewing' | 'awaiting_approval' | 'executing' | 'auto_fixing' | 'done' | 'failed'
  @Column({ type: 'text', default: 'pending' })
  status!: string;

  /**
   * The post-build review agents (lenses) and their per-agent status — seeded when the thread enters
   * `auto_fixing`, transitioned by the auto-fix stage, surfaced by `getPipelineState` so the navigator's
   * review folder can show each agent's state. `[]` until the thread is reviewed (getPipelineState falls
   * back to the default lens set for an empty array). LITERAL default — a `() => '[]'::jsonb` function
   * default makes `migration:generate` loop forever (see the jsonb-default-loop memory).
   */
  @Column({ type: 'jsonb', default: [] })
  review_agents!: ReviewAgentState[];

  /**
   * The thread's LLM-authored task list — folded incrementally from the orchestrating session's
   * `TaskCreate`/`TaskUpdate` tool calls at the shared transcript harness (see `TurnHarnessFactory`), so
   * the navigator's TASKS section renders durable state instead of the client refolding the transcript.
   * `[]` until the session creates its first task — there is no fixed/expected set (unlike
   * `review_agents`), so `getPipelineState` does NOT fall back to a computed default here. LITERAL
   * default — see the `review_agents` doc above for why a function default breaks `migration:generate`.
   */
  @Column({ type: 'jsonb', default: [] })
  tasks!: TaskItem[];
}

/** One post-build review agent's persisted state on a thread. */
export interface ReviewAgentState {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
  findings?: number;
}

/** One LLM-authored task, folded from `TaskCreate`/`TaskUpdate` tool calls (see `ThreadEntity.tasks`). */
export interface TaskItem {
  id: string;
  subject: string;
  status: 'pending' | 'in_progress' | 'completed' | 'dropped';
  /** The SDK task's longer description — the navigator shows it under an in_progress task + as tooltip. */
  description?: string;
  /** Present-continuous label ("Resolving the router chain") shown while in_progress; falls back to subject. */
  activeForm?: string;
  /** Dependency edges — ids of tasks this one waits on. A PENDING task with an incomplete blocker renders
   *  BLOCKED; the block clears by derivation when every blocker completes or is deleted. */
  blockedBy?: string[];
}
