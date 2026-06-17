import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { TimestampedEntity } from './classes/base.entity';

/**
 * One REVIEW attempt over a built phase — a read-only session that judges the just-committed work and
 * reports a verdict. `attempt` increments per phase (a blocker can trigger a fix + re-review in later
 * phases), `status` tracks the review session's lifecycle, and `blocker`/`summary` capture the parsed
 * verdict. v1 is advisory (the runner advances regardless); the row is the durable lineage that
 * Phase 5's multi-lens review + cross-section defect routing build on.
 */
@Entity({ name: 'pipeline_phase_reviews' })
@Index(['run_id'])
@Index(['phase_id'])
export class PipelinePhaseReview extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The phase this review covers (pipeline_run_phases.id — not a DB FK, matching the raw-SQL style). */
  @Column({ type: 'uuid' })
  phase_id!: string;

  /** The owning run (denormalized for run-scoped queries). */
  @Column({ type: 'uuid' })
  run_id!: string;

  /** The tenant (Slack team id) — denormalized for team-scoped queries. */
  @Column({ type: 'text' })
  team_id!: string;

  /** Which review attempt this is for the phase (1-based). */
  @Column({ type: 'int', default: 1 })
  attempt!: number;

  // 'running' | 'done' | 'failed'
  @Column({ type: 'text', default: 'running' })
  status!: string;

  /** The harness background Session id running this review (the resume handle). NULL until opened. */
  @Column({ type: 'text', nullable: true })
  engine_session_id!: string | null;

  /** The parsed verdict's `blocker` flag (NULL until the review reports). */
  @Column({ type: 'boolean', nullable: true })
  blocker!: boolean | null;

  /** The parsed verdict's one-line summary. */
  @Column({ type: 'text', nullable: true })
  summary!: string | null;
}
