import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { TimestampedEntity } from './classes/base.entity';

/**
 * Durable state seam for orchestrator pipelines. A pipeline_run row tracks one execution of a named
 * pipeline (e.g. "feature") against a board task, carrying enough state to recover mid-pipeline on
 * restart — the in-process session/workspace handles vanish on restart, but this row's stage_index,
 * current_role, and session_id let the orchestrator re-enter at the correct stage.
 */
@Entity({ name: 'pipeline_runs' })
@Index(['team_id', 'task_id'])
@Index(['team_id', 'status'])
export class PipelineRun extends TimestampedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The tenant (Slack team id) this run belongs to. */
  @Column({ type: 'text' })
  team_id!: string;

  /** The board task id this pipeline is working (team_tasks.id — not a FK, just the id). */
  @Column({ type: 'int' })
  task_id!: number;

  /** The pipeline name, e.g. "feature". */
  @Column({ type: 'text' })
  pipeline!: string;

  /** The current stage index within the pipeline definition (0-based). */
  @Column({ type: 'int', default: 0 })
  stage_index!: number;

  // 'running' | 'paused' | 'done' | 'failed'
  @Column({ type: 'text', default: 'running' })
  status!: string;

  /** The employee id of the stage currently executing; NULL between stages. */
  @Column({ type: 'text', nullable: true })
  current_role!: string | null;

  /** The turn mode for the active stage ('plan' | 'execute' | 'investigate'). */
  @Column({ type: 'text', nullable: true })
  mode!: string | null;

  /** The workspace id the active stage runs in. */
  @Column({ type: 'text', nullable: true })
  workspace_id!: string | null;

  /** The session id for the active stage's engine conversation. */
  @Column({ type: 'text', nullable: true })
  session_id!: string | null;

  /** The surface/thread the orchestrator is notified on. Stored so a paused run can resume after the
   * stage session is gone (the durable row, not a live session, carries the resume coordinates). */
  @Column({ type: 'text', nullable: true })
  notify_thread!: string | null;

  /** The project the pipeline's task belongs to — workspace/session context needed to re-open a stage. */
  @Column({ type: 'text', nullable: true })
  project!: string | null;

  /**
   * What KIND of run this is: 'feature' (the dynamic section-driver loop — sections in
   * `pipeline_run_sections`, advanced by the 2-D cursor below) or 'bugfix' (a single execute session
   * straight to the PR gate, no plan gate / no sections). Legacy flat-`feature`-pipeline rows also
   * read 'feature' but are driven by `stage_index` instead of the cursor.
   */
  @Column({ type: 'text', default: 'feature' })
  kind!: string;

  /** Section-driver cursor: which section (0-based) of `pipeline_run_sections` is active. */
  @Column({ type: 'int', default: 0 })
  section_index!: number;

  /** Section-driver cursor: which build-phase chunk (0-based) within the active section is running. */
  @Column({ type: 'int', default: 0 })
  phase_index!: number;

  /** The active section's planning sub-state: 'drafting' (plan session live) | 'gate' (proposed,
   * paused, awaiting approval) | NULL (building / not planning). */
  @Column({ type: 'text', nullable: true })
  planning_substep!: string | null;

  /** The high-level plan Atlas + Dennis agreed on during scoping (the feature's intent, stack,
   * constraints, and how the sections fit together). Seeded into EVERY section's just-in-time plan
   * prompt so each section is grounded in the whole, not just its one-line brief. */
  @Column({ type: 'text', nullable: true })
  overview!: string | null;

  /** The section currently live (a SOFT pointer into pipeline_run_sections — recomputable from section
   * statuses; the section rows are authoritative). The explicit-row replacement for `section_index`;
   * the positional cursor is dual-written through the transition and dropped in a later drain window. */
  @Column({ type: 'uuid', nullable: true })
  active_section_id!: string | null;
}
