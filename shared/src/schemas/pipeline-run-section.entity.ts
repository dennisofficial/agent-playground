import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { TimestampedEntity } from './classes/base.entity';

/**
 * One SECTION of a dynamic section-driver pipeline run (e.g. "backend", then "frontend"). Atlas
 * declares the section list at dispatch (emergent from chat planning); each section is then planned
 * just-in-time and built sequentially. This is the durable archive + per-section state the
 * `pipeline_runs` cursor (section_index) advances over — so a restart re-enters the right section,
 * and a prior section's approved plan survives even though `team_task_plans` only ever holds the
 * currently-active section's plan (overwritten per section).
 */
@Entity({ name: 'pipeline_run_sections' })
@Index(['run_id'])
@Unique(['run_id', 'ordinal'])
export class PipelineRunSection extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The owning pipeline_runs.id (not a DB FK — just the id, matching the store's raw-SQL style). */
  @Column({ type: 'uuid' })
  run_id!: string;

  /** The tenant (Slack team id) — denormalized for team-scoped queries. */
  @Column({ type: 'text' })
  team_id!: string;

  /** Execution order, GAP-NUMBERED (10, 20, 30…) so a mid-run insert needs no renumber. */
  @Column({ type: 'int' })
  ordinal!: number;

  /** Section name, e.g. "backend" / "frontend" (Atlas-authored at dispatch). */
  @Column({ type: 'text' })
  name!: string;

  /** Atlas's one-line intent for this section (seeds the just-in-time plan session). */
  @Column({ type: 'text', nullable: true })
  brief!: string | null;

  /** The phase-config (synthetic worker) id this section's sessions run as, e.g. "phase_backend". */
  @Column({ type: 'text' })
  phase_role!: string;

  // 'pending' | 'planning' | 'building' | 'done' | 'failed'
  @Column({ type: 'text', default: 'pending' })
  status!: string;

  /** The APPROVED plan (MD#2), archived here at the section's gate (team_task_plans is overwritten). */
  @Column({ type: 'text', nullable: true })
  plan_md!: string | null;

  /** The parsed phase manifest from the approved plan's fenced `phases` block (per-phase ranges + the
   * `reviewed` markers that keep boot-recovery from re-running a completed review). */
  @Column({ type: 'jsonb', nullable: true })
  phases_json!: unknown;

  /** Number of build phases parsed from the approved plan (NULL until parsed; fallback 1). */
  @Column({ type: 'int', nullable: true })
  phase_count!: number | null;

  /** Ordinals (this run's section ordinals) this section waits on — its dependency-ordered position
   * in the living queue. Default empty = strictly ordinal-sequential. `nextPending` topo-picks over it;
   * a forward/cyclic dependency is rejected at insert/reorder time, so it stays acyclic. */
  @Column('int', { array: true, default: () => "'{}'" })
  depends_on!: number[];

  /** Set once the section has committed work in the shared workspace (it enters `building`, or a design
   * section's artifact lands). A frozen section is IMMUTABLE: living-section ops may never reorder it
   * nor wedge a new section before it — you may only append after committed work. Replaces the implicit
   * done/building immutability the positional cursor relied on. */
  @Column({ type: 'boolean', default: false })
  frozen!: boolean;

  /** The harness background Session id currently live for this section (plan / coding / review). A soft
   * pointer (recomputable from the run) kept for awareness + debugging; NULL between sessions. */
  @Column({ type: 'text', nullable: true })
  active_session_id!: string | null;
}
