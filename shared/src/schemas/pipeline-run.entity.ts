import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { TimestampedEntity } from './classes/base.entity';

/**
 * Durable state seam for orchestrator pipelines. A pipeline_run row tracks one execution of a named
 * pipeline (e.g. "feature") against a board task, carrying enough state to recover mid-pipeline on
 * restart — the in-process session/worktree handles vanish on restart, but this row's stage_index,
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

  /** The worktree id the active stage runs in. */
  @Column({ type: 'text', nullable: true })
  worktree_id!: string | null;

  /** The session id for the active stage's engine conversation. */
  @Column({ type: 'text', nullable: true })
  session_id!: string | null;
}
