import { PipelineRun as PipelineRunEntity } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';
import { rawRows, toIso } from './sql';

export type PipelineRunStatus = 'running' | 'paused' | 'done' | 'failed';
/** 'feature' = dynamic section-driver loop; 'bugfix' = single execute session → PR gate. */
export type PipelineRunKind = 'feature' | 'bugfix';
/** The active section's sub-state: 'drafting' (the plan session is running), 'advisory' (the plan
 * turn reported and the one-shot codex_advisory self-review ran inside it — the transient window
 * before the gate is posted; a crash here re-plans), 'gate' (paused for Dennis's approval),
 * 'awaiting_design' (a design section paused for the human's artifact), 'stage_decision' (paused at a
 * review-stage decision Atlas owns — a cross-section defect / blocker; resumes via the fix-up or
 * reopen-section tools), 'fixup' (a harness-opened fix-up session is running against the integrated
 * worktree; its report re-enters the PR gate), or undefined while building. */
export type PlanningSubstep =
  | 'drafting'
  | 'advisory'
  | 'gate'
  | 'awaiting_design'
  | 'stage_decision'
  | 'fixup';

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
  notifyThread?: string;
  project?: string;
  kind: PipelineRunKind;
  sectionIndex: number;
  phaseIndex: number;
  planningSubstep?: PlanningSubstep;
  /** The agreed high-level plan (feature runs) — seeds every section's just-in-time plan prompt. */
  overview?: string;
  /** Soft pointer to the live section (pipeline_run_sections.id); the section rows are authoritative. */
  activeSectionId?: string;
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
  notifyThread?: string;
  project?: string;
  kind?: PipelineRunKind;
  sectionIndex?: number;
  phaseIndex?: number;
  planningSubstep?: PlanningSubstep;
  overview?: string;
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
  notify_thread: string | null;
  project: string | null;
  kind: string;
  section_index: number | string;
  phase_index: number | string;
  planning_substep: string | null;
  overview: string | null;
  active_section_id: string | null;
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
  notifyThread: r.notify_thread ?? undefined,
  project: r.project ?? undefined,
  kind: (r.kind as PipelineRunKind) ?? 'feature',
  sectionIndex: Number(r.section_index),
  phaseIndex: Number(r.phase_index),
  planningSubstep: (r.planning_substep as PlanningSubstep) ?? undefined,
  overview: r.overview ?? undefined,
  activeSectionId: r.active_section_id ?? undefined,
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
    // NOTE: `current_role` is a RESERVED word in Postgres (the CURRENT_ROLE function), so it MUST be
    // double-quoted as a column identifier — unquoted it fails to parse ("syntax error at or near
    // current_role") and the INSERT never runs. Same applies to the UPDATE in update() below.
    const rows = await this.q(
      `INSERT INTO pipeline_runs
         (team_id, task_id, pipeline, stage_index, status, "current_role", mode, worktree_id, session_id, notify_thread, project, kind, section_index, phase_index, planning_substep, overview, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, now(), now())
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
        n.notifyThread ?? null,
        n.project ?? null,
        n.kind ?? 'feature',
        n.sectionIndex ?? 0,
        n.phaseIndex ?? 0,
        n.planningSubstep ?? null,
        n.overview ?? null,
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
      sectionIndex?: number;
      phaseIndex?: number;
      planningSubstep?: PlanningSubstep | null;
      activeSectionId?: string | null;
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
    if ('currentRole' in patch) set('"current_role"', patch.currentRole ?? null);
    if ('mode' in patch) set('mode', patch.mode ?? null);
    if ('worktreeId' in patch) set('worktree_id', patch.worktreeId ?? null);
    if ('sessionId' in patch) set('session_id', patch.sessionId ?? null);
    if (patch.sectionIndex !== undefined)
      set('section_index', patch.sectionIndex);
    if (patch.phaseIndex !== undefined) set('phase_index', patch.phaseIndex);
    if ('planningSubstep' in patch)
      set('planning_substep', patch.planningSubstep ?? null);
    if ('activeSectionId' in patch)
      set('active_section_id', patch.activeSectionId ?? null);
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

  /** All running or paused runs across every team, oldest first — for boot recovery (resumePipelines). */
  async listAllActive(): Promise<PipelineRun[]> {
    const rows = await this.q(
      `SELECT * FROM pipeline_runs WHERE status = ANY($1) ORDER BY created_at ASC`,
      [['running', 'paused']],
    );
    return rows.map(toRun);
  }
}
