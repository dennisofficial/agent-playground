import { PipelineRun as PipelineRunEntity } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';
import { rawRows, toIso } from './sql';

export type PipelineRunStatus = 'running' | 'paused' | 'done' | 'failed';

export interface PipelineRun {
  id: string;
  team: string;
  taskId: number;
  pipeline: string;
  stageIndex: number;
  status: PipelineRunStatus;
  currentRole?: string;
  mode?: string;
  worktreeId?: string;
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewPipelineRun {
  team: string;
  taskId: number;
  pipeline: string;
  stageIndex?: number;
  status?: PipelineRunStatus;
  currentRole?: string;
  mode?: string;
  worktreeId?: string;
  sessionId?: string;
}

interface PipelineRunRow {
  id: string;
  team_id: string;
  task_id: number | string;
  pipeline: string;
  stage_index: number | string;
  status: string;
  current_role: string | null;
  mode: string | null;
  worktree_id: string | null;
  session_id: string | null;
  created_at: unknown;
  updated_at: unknown;
}

const toRun = (r: PipelineRunRow): PipelineRun => ({
  id: r.id,
  team: r.team_id,
  taskId: Number(r.task_id),
  pipeline: r.pipeline,
  stageIndex: Number(r.stage_index),
  status: r.status as PipelineRunStatus,
  currentRole: r.current_role ?? undefined,
  mode: r.mode ?? undefined,
  worktreeId: r.worktree_id ?? undefined,
  sessionId: r.session_id ?? undefined,
  createdAt: toIso(r.created_at),
  updatedAt: toIso(r.updated_at),
});

/**
 * Durable state store for pipeline runs. Each row is one execution of a named pipeline against a
 * board task — enough state to re-enter the correct stage on restart (stage_index, current_role,
 * session_id). The store is append-friendly: a new run per retry rather than mutating the old one.
 */
export class PipelineRunStore {
  constructor(private readonly repo: Repository<PipelineRunEntity>) {}

  private async q(sql: string, params: unknown[]): Promise<PipelineRunRow[]> {
    return rawRows<PipelineRunRow>(await this.repo.manager.query(sql, params));
  }

  /** Insert a new pipeline run and return the created row. */
  async create(n: NewPipelineRun): Promise<PipelineRun> {
    const rows = await this.q(
      `INSERT INTO pipeline_runs
         (team_id, task_id, pipeline, stage_index, status, current_role, mode, worktree_id, session_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), now())
       RETURNING *`,
      [
        n.team,
        n.taskId,
        n.pipeline,
        n.stageIndex ?? 0,
        n.status ?? 'running',
        n.currentRole ?? null,
        n.mode ?? null,
        n.worktreeId ?? null,
        n.sessionId ?? null,
      ],
    );
    return toRun(rows[0]);
  }

  /** Fetch a single run by id within a team, or undefined. */
  async get(team: string, id: string): Promise<PipelineRun | undefined> {
    const rows = await this.q(
      `SELECT * FROM pipeline_runs WHERE id = $1 AND team_id = $2`,
      [id, team],
    );
    return rows[0] ? toRun(rows[0]) : undefined;
  }

  /** Most-recent run for a board task, or undefined. */
  async getByTask(team: string, taskId: number): Promise<PipelineRun | undefined> {
    const rows = await this.q(
      `SELECT * FROM pipeline_runs WHERE team_id = $1 AND task_id = $2 ORDER BY created_at DESC LIMIT 1`,
      [team, taskId],
    );
    return rows[0] ? toRun(rows[0]) : undefined;
  }

  /** Guarded partial update — only fields present in patch are written; updated_at always set. */
  async update(
    team: string,
    id: string,
    patch: {
      stageIndex?: number;
      status?: PipelineRunStatus;
      currentRole?: string | null;
      mode?: string | null;
      worktreeId?: string | null;
      sessionId?: string | null;
    },
  ): Promise<PipelineRun | undefined> {
    const sets: string[] = ['updated_at = now()'];
    const args: unknown[] = [id, team];
    const set = (col: string, v: unknown) => {
      args.push(v);
      sets.push(`${col} = $${args.length}`);
    };
    if (patch.stageIndex !== undefined) set('stage_index', patch.stageIndex);
    if (patch.status !== undefined) set('status', patch.status);
    if ('currentRole' in patch) set('current_role', patch.currentRole ?? null);
    if ('mode' in patch) set('mode', patch.mode ?? null);
    if ('worktreeId' in patch) set('worktree_id', patch.worktreeId ?? null);
    if ('sessionId' in patch) set('session_id', patch.sessionId ?? null);
    const rows = await this.q(
      `UPDATE pipeline_runs SET ${sets.join(', ')} WHERE id = $1 AND team_id = $2 RETURNING *`,
      args,
    );
    return rows[0] ? toRun(rows[0]) : undefined;
  }

  /** All running or paused runs for a team, oldest first (work-queue order). */
  async listActive(team: string): Promise<PipelineRun[]> {
    const rows = await this.q(
      `SELECT * FROM pipeline_runs WHERE team_id = $1 AND status = ANY($2) ORDER BY created_at ASC`,
      [team, ['running', 'paused']],
    );
    return rows.map(toRun);
  }
}
