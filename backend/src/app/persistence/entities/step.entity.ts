import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';
import { OrganizationEntity } from './organization.entity';
import { ThreadEntity } from './thread.entity';
import { JobEntity } from './job.entity';

/**
 * One STEP of a thread's plan — runs as a FRESH session on the feature branch (fresh context per step
 * keeps the window small + avoids hallucination; the shared checkout lets later steps build on earlier
 * code). `stage` + `status` are the EXPLICIT, resumable cursor — the deterministic driver re-enters
 * here on restart rather than re-deriving control flow from statuses. Strictly sequential within a
 * thread; gap-numbered.
 */
@Entity({ name: 'steps' })
@Index(['thread_id'])
@Index(['job_id'])
@Unique(['thread_id', 'ordinal'])
export class StepEntity extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The owning thread/lane (FK → threads.id). */
  @Column({ type: 'uuid' })
  thread_id!: string;

  @ManyToOne(() => ThreadEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'thread_id' })
  thread?: ThreadEntity;

  /** The owning job/container (denormalized for job-scoped boot recovery; FK → jobs.id). */
  @Column({ type: 'uuid' })
  job_id!: string;

  @ManyToOne(() => JobEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'job_id' })
  job?: JobEntity;

  /** The tenant (org id) — denormalized for org-scoped queries (FK → organizations.id). */
  @Column({ type: 'uuid' })
  org_id!: string;

  @ManyToOne(() => OrganizationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'org_id' })
  org?: OrganizationEntity;

  /** Execution order within the thread, GAP-NUMBERED (10, 20, 30…) so a re-plan can splice. */
  @Column({ type: 'int' })
  ordinal!: number;

  /** The step title from the plan, if any. */
  @Column({ type: 'text', nullable: true })
  title!: string | null;

  /** The step brief/instructions from the locked plan. */
  @Column({ type: 'text' })
  brief!: string;

  /**
   * The EXPLICIT resumable stage within the step — the driver re-enters here after a restart instead
   * of re-deriving control flow. E.g. 'build' | 'review' | 'fix'.
   */
  @Column({ type: 'text', default: 'build' })
  stage!: string;

  // 'pending' | 'building' | 'reviewing' | 'done' | 'failed' | 'skipped'
  @Column({ type: 'text', default: 'pending' })
  status!: string;

  /** The engine session this step runs inside; null until started. */
  @Column({ type: 'text', nullable: true })
  session_id!: string | null;

  /**
   * Which execution BATCH this step belongs to within its thread. A fresh-context step packs the ordered
   * steps into consecutive groups; every step in one group runs in ONE engine session. Null until the
   * thread first executes; assigned + persisted then so a resumed/restarted thread re-groups IDENTICALLY
   * — the resume cursor keys off the group's anchor step `session_id`, so batch membership MUST be
   * stable across a restart.
   */
  @Column({ type: 'int', nullable: true })
  batch_ordinal!: number | null;

  /**
   * Set on the batch ANCHOR step the instant its batch commits, BEFORE the per-step `status='done'`
   * writes — the atomic-resume marker. Non-null ⇒ the batch already committed, so a resume fast-forwards
   * (marks steps done) instead of re-running against an already-committed tree. Sentinel `(nothing)` =
   * "committed, empty diff". Null on non-anchor steps and before commit.
   */
  @Column({ type: 'text', nullable: true })
  commit_sha!: string | null;

  // ── Leg rotation (context-rot mitigation) ──────────────────────────────────────────────────────────
  // One build thread spans many sequential engine sessions ("Legs"). When the anchor's live session fills
  // its context window, we ROTATE: author a structured handoff, abandon the fat session, and start a fresh
  // one seeded with that handoff. These mirror the brain's compaction trio on `job_sandboxes`. Crucially,
  // `commit_sha`/`batch_ordinal` above are NEVER touched by rotation — the atomic-resume fast-forward keys
  // off them, so a rotation must not masquerade as a committed batch. WIP survives on disk in the worktree.

  /**
   * The fat session being abandoned mid-rotation (analog of `job_sandboxes.compacting_session_id`). Set
   * before the handoff is authored; a restart signal (if `session_id` still equals this, the reseed never
   * committed) and a re-attach guard (never re-attach a session equal to this). Cleared when the fresh Leg
   * session is born.
   */
  @Column({ type: 'text', nullable: true })
  rotating_session_id!: string | null;

  /**
   * The structured handoff (`ROTATION_PREAMBLE + summary`) folded into the NEXT Leg's task, exactly as the
   * brain folds `pending_compaction_seed` (analog of that column). Set at rotation; cleared the instant the
   * fresh session is born. A crash before the clear re-folds it next turn (safe).
   */
  @Column({ type: 'text', nullable: true })
  pending_leg_seed!: string | null;

  /** Which Leg (1..N) the anchor is currently on. Incremented on each rotation; surfaced in the UI. */
  @Column({ type: 'int', default: 1 })
  leg_ordinal!: number;
}
