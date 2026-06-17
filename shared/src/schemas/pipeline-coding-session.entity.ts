import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { TimestampedEntity } from './classes/base.entity';

/**
 * A CODING SESSION — an execution grouping of CONSECUTIVE phases sharing one engine context (the way
 * Dennis works: tight context, fewer hallucinations). For now each phase has its own coding session
 * (1:1); Phase 4 folds contiguous phases into one. `engine_session_id` links to the harness
 * background Session running the group; `handoff_in`/`handoff_out` carry the structured handoff a
 * prior group leaves the next (Phase 4). Sequential within a section (ORDER BY ordinal).
 */
@Entity({ name: 'pipeline_coding_sessions' })
@Index(['run_id'])
@Index(['section_id'])
@Unique(['section_id', 'ordinal'])
export class PipelineCodingSession extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The owning section (pipeline_run_sections.id — not a DB FK, matching the store's raw-SQL style). */
  @Column({ type: 'uuid' })
  section_id!: string;

  /** The owning run (denormalized for run-scoped boot recovery / awareness queries). */
  @Column({ type: 'uuid' })
  run_id!: string;

  /** The tenant (Slack team id) — denormalized for team-scoped queries. */
  @Column({ type: 'text' })
  team_id!: string;

  /** Execution order within the section, GAP-NUMBERED (10, 20, 30…). */
  @Column({ type: 'int' })
  ordinal!: number;

  // 'pending' | 'building' | 'reviewing' | 'done' | 'failed'
  @Column({ type: 'text', default: 'pending' })
  status!: string;

  /** The harness background Session id running this group's turns (the resume handle). NULL until opened. */
  @Column({ type: 'text', nullable: true })
  engine_session_id!: string | null;

  /** The handoff note this group inherited from the prior group (Phase 4). */
  @Column({ type: 'text', nullable: true })
  handoff_in!: string | null;

  /** The handoff note this group produced for the next group (Phase 4). */
  @Column({ type: 'text', nullable: true })
  handoff_out!: string | null;
}
