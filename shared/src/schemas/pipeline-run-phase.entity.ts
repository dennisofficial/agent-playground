import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { TimestampedEntity } from './classes/base.entity';

/**
 * One PHASE of a section's approved plan — an explicit row whose `status` IS the cursor (the
 * positional `pipeline_runs.phase_index` is dual-written during the transition but rows are
 * authoritative for navigation). A phase belongs to a section, runs inside a coding session
 * (`coding_session_id`), and is reviewed once built. Strictly sequential within a section
 * (ORDER BY ordinal); gap-numbered so a future re-plan can splice without renumbering.
 */
@Entity({ name: 'pipeline_run_phases' })
@Index(['run_id'])
@Index(['section_id'])
@Unique(['section_id', 'ordinal'])
export class PipelineRunPhase extends TimestampedEntity {
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

  /** Execution order within the section, GAP-NUMBERED (10, 20, 30…) so a re-plan can splice. */
  @Column({ type: 'int' })
  ordinal!: number;

  /** The stable phase id from the approved plan's fenced `phases` block (the plan's own label). */
  @Column({ type: 'int' })
  plan_phase_id!: number;

  /** The phase title from the plan, if any. */
  @Column({ type: 'text', nullable: true })
  title!: string | null;

  // 'pending' | 'building' | 'reviewing' | 'done' | 'failed' | 'skipped'
  @Column({ type: 'text', default: 'pending' })
  status!: string;

  /** The coding session this phase runs inside (Phase 4 groups consecutive phases into one session;
   * for now each phase has its own). NULL until the section is approved and the rows are materialized. */
  @Column({ type: 'uuid', nullable: true })
  coding_session_id!: string | null;
}
