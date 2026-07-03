import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { TimestampedEntity } from '@workspace/shared/schemas';
import { JobEntity } from './job.entity';

/**
 * One ROUND of the async Codex plan pre-review (see `brain/plan-review.service.ts`).
 *
 * When Atlas calls `submit_plan` the thread enters `plan_review`: a row is created here (status
 * `running`) with the rendered review `prompt`, and a background Codex turn runs in the thread's
 * sandbox (5-30 min). On completion the row is stamped (`findings`, `completed_at`, `status`) and the
 * findings are delivered to Atlas as a harness-seeded message in a server-initiated turn; `delivered_at`
 * is stamped once that delivery turn runs. Each `submit_plan` is a new `round` (bounded), so this table
 * is the durable, at-least-once spine that survives a host restart mid-review (boot reconciliation
 * re-runs `running` rows whose Codex exec was lost, and re-delivers `complete`/`failed` rows whose
 * delivery turn was lost — mirroring the `ask_question` gate).
 */
@Entity({ name: 'plan_reviews' })
@Index(['job_id', 'round'])
@Index(['status'])
export class PlanReviewEntity extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The thread whose plan is under review (FK → threads.id). */
  @Column({ type: 'uuid' })
  job_id!: string;

  @ManyToOne(() => JobEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'job_id' })
  thread?: JobEntity;

  /** The tenant (denormalized for sandbox resolution + scoping). */
  @Column({ type: 'uuid' })
  org_id!: string;

  /** The draft decision record this review round graded (audit; null if none at review time). */
  @Column({ type: 'uuid', nullable: true })
  decision_record_id!: string | null;

  /** 1-based review round on this thread (each `submit_plan` increments; bounded by the round cap). */
  @Column({ type: 'int' })
  round!: number;

  /** Lifecycle: 'running' (Codex turn in flight) | 'complete' | 'failed'. */
  @Column({ type: 'text', default: 'running' })
  status!: string;

  /**
   * The fully-rendered review input handed to Codex (overview + locked decisions + threads & authored
   * steps). Stored so a boot-time re-run reconstructs the exact turn without re-deriving it from rows.
   */
  @Column({ type: 'text' })
  prompt!: string;

  /** The parsed findings (bulleted) once the Codex turn completes; '' = clean; null = not yet run. */
  @Column({ type: 'text', nullable: true })
  findings!: string | null;

  /**
   * On a FAILED review, a concise human-readable reason (engine/auth error, no sandbox, …) so the failure
   * is SURFACED to Atlas + the operator instead of masquerading as "no findings". Null on success.
   */
  @Column({ type: 'text', nullable: true })
  error!: string | null;

  /** When the Codex turn finished (null while running). */
  @Column({ type: 'timestamptz', nullable: true })
  completed_at!: Date | null;

  /** When the findings were delivered to Atlas in a turn that actually ran (null until delivered). */
  @Column({ type: 'timestamptz', nullable: true })
  delivered_at!: Date | null;

  /**
   * The Codex SDK thread/session id this review round ran on (captured at turn start). ONE conversation
   * per job: round 1 starts a fresh Codex thread; every later round + every `respond_to_review` reply
   * RESUMES the latest non-null id for the job, so Codex keeps its memory of prior findings and can judge
   * whether Atlas's revision/pushback actually resolved them (vs re-reviewing blind each round). Null
   * until the turn emits its session event.
   */
  @Column({ type: 'text', nullable: true })
  codex_session_id!: string | null;

  /**
   * When the plan-review WEDGE reconciler re-drove a finalize nudge for this round (null = never). Set
   * AFTER the nudge turn ran. Guards the reconciler against an infinite loop: a job left stuck in
   * `plan_review` (review terminal + delivered, but the brain never called `finalize_plan` — a crash cut
   * the turn off, or it simply stopped) is nudged AT MOST ONCE per review round. A later `submit_plan`
   * opens a NEW round (a fresh row, null again), so a genuine re-review is still eligible for its own
   * one-shot nudge. See `AgentSessionManager.reconcileWedgedPlanReviews`.
   */
  @Column({ type: 'timestamptz', nullable: true })
  finalize_nudged_at!: Date | null;
}
