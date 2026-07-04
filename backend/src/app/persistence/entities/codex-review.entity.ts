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
 * One synchronous Codex plan review conversation for a job (see `brain/plan-review.service.ts`).
 *
 * Codex review is no longer an async gate: Atlas invokes `review_plan` as a SYNCHRONOUS in-turn tool that
 * blocks the brain turn until the read-only Codex review of `/context/specs/` returns, then feeds the
 * severity-tagged findings straight back into the same turn. Atlas re-opens the same review (revise +
 * re-review) as often as it likes — each call RESUMES `codex_session_id` so Codex keeps its memory of
 * prior findings (adjudication, not blind re-review); no round cap (only a high safety ceiling on
 * `resume_count`). Review is mandatory to RUN but advisory to PASS — findings never block; Atlas decides
 * when the plan is ready and calls `propose_plan`.
 *
 * This row is the slim durability + gate spine (it REPLACES the old async `plan_reviews` delivery spine):
 * - `codex_session_id` (persisted eagerly on the `{kind:'session'}` event) lets a re-dispatched
 *   `review_plan` (after a host restart mid-review) RESUME the Codex thread instead of starting fresh.
 * - `spec_hash` ties a completed review to the exact `/context/specs/` version it read, so `propose_plan`'s
 *   mandatory-run gate accepts it only for the plan version being proposed (a later spec edit → mismatch →
 *   re-review required).
 * - `status = 'running'` is the durable WORK-OWED signal: a running row whose job has no live brain turn is
 *   the interrupted-`review_plan` fingerprint the backstop re-drives (it survives the Redis stream cleanup
 *   that wipes tool-bridge recovery on the alive-grace/watchdog path).
 */
@Entity({ name: 'codex_reviews' })
@Index(['job_id'])
@Index(['status'])
export class CodexReviewEntity extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The job whose plan is under review (FK → jobs.id). */
  @Column({ type: 'uuid' })
  job_id!: string;

  @ManyToOne(() => JobEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'job_id' })
  job?: JobEntity;

  /** The tenant (denormalized for sandbox resolution + scoping). */
  @Column({ type: 'uuid' })
  org_id!: string;

  /**
   * The Codex SDK thread/session id this review runs on (captured eagerly at turn start). ONE conversation
   * per job: the first `review_plan` starts a fresh Codex thread; every later call RESUMES this id, so
   * Codex remembers its prior findings and can judge whether Atlas's revision/pushback actually resolved
   * them (vs re-reviewing blind). Null until the turn emits its session event.
   */
  @Column({ type: 'text', nullable: true })
  codex_session_id!: string | null;

  /**
   * Hash of the `/context/specs/` files the LAST completed review actually read — the plan version this
   * review graded. `propose_plan` re-hashes the current specs and accepts this row for the mandatory-run
   * gate only when the hashes match (so a spec edit after review forces a re-review). Set on each run.
   */
  @Column({ type: 'text', nullable: true })
  spec_hash!: string | null;

  /** Lifecycle: 'running' (a `review_plan` call is in flight) | 'complete' | 'failed' (engine/timeout). */
  @Column({ type: 'text', default: 'running' })
  status!: string;

  /**
   * The parsed, severity-tagged findings from the latest completed run (serialized), or '' when the review
   * was clean (NO_FINDINGS); null while running / on a failed run. Advisory — never gates approval.
   */
  @Column({ type: 'text', nullable: true })
  findings!: string | null;

  /**
   * On a FAILED review (engine/auth error, timeout, no sandbox), a concise human-readable reason so the
   * failure is SURFACED to Atlas + the operator instead of masquerading as "no findings". Null on success.
   */
  @Column({ type: 'text', nullable: true })
  error!: string | null;

  /**
   * How many times `review_plan` has resumed this conversation. Bounds a pathological re-review loop via a
   * high safety ceiling (NOT a product round cap — Atlas converges by judgment well before it).
   */
  @Column({ type: 'int', default: 0 })
  resume_count!: number;
}
