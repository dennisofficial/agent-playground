import {
  type BoardTaskView,
  type PhaseView,
  type PipelineRunView,
  type PlanRowView,
  type PlanView,
  type SectionView,
} from '@workspace/shared';
import { TeamTask } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';
import { rawRows, toIso } from '../memory/sql';

interface TaskRow {
  id: number | string;
  project: string;
  title: string;
  description: string;
  status: string;
  assignee: string | null;
  created_by: string;
  depends_on: number[] | null;
  shared_slug: string | null;
  created_at: unknown;
  updated_at: unknown;
}

interface PlanRow {
  id: number | string;
  task_id: number | string;
  employee: string;
  plan_md: string;
  lead_status: string;
  owner_status: string;
  pr_url: string | null;
  created_at: unknown;
  updated_at: unknown;
}

interface RunRow {
  id: string;
  task_id: number | string;
  pipeline: string;
  kind: string;
  status: string;
  planning_substep: string | null;
  overview: string | null;
  active_section_id: string | null;
  section_index: number | string;
  phase_index: number | string;
  created_at: unknown;
  updated_at: unknown;
}

interface SectionRow {
  id: string;
  ordinal: number | string;
  name: string;
  brief: string | null;
  phase_role: string;
  status: string;
  plan_md: string | null;
  depends_on: number[] | null;
}

interface PhaseRow {
  id: string;
  section_id: string;
  ordinal: number | string;
  plan_phase_id: number | string;
  title: string | null;
  status: string;
}

function toBoardTaskView(r: TaskRow): BoardTaskView {
  return {
    id: Number(r.id),
    project: r.project,
    title: r.title,
    description: r.description,
    status: r.status,
    assignee: r.assignee,
    createdBy: r.created_by,
    dependsOn: r.depends_on ?? [],
    sharedSlug: r.shared_slug,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

function toPlanRowView(r: PlanRow): PlanRowView {
  return {
    id: Number(r.id),
    taskId: Number(r.task_id),
    employee: r.employee,
    planMd: r.plan_md,
    leadStatus: r.lead_status,
    ownerStatus: r.owner_status,
    prUrl: r.pr_url,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

const TASK_COLS = `id, project, title, description, status, assignee, created_by, depends_on, shared_slug, created_at, updated_at`;

/**
 * Read-only view over the team board, plans, and feature pipelines for the web Plan Viewer.
 * No scope-guarding beyond the tenant id (the admin auth bearer is the only gate).
 *
 * Slim, harness-free — takes a single `Repository<TeamTask>` and runs raw SQL through its manager
 * across the board/plan/pipeline tables (FK-less raw-SQL house style); zero LLM/employee deps.
 * All writes go through the harness stores (`BoardStore`, `PlanStore`, `PipelineRun*Store`).
 */
export class PlanViewStore {
  constructor(private readonly repo: Repository<TeamTask>) {}

  private async query<T>(sql: string, params: unknown[]): Promise<T[]> {
    return rawRows<T>(await this.repo.manager.query(sql, params));
  }

  /**
   * The full viewer payload for one task: the task, its single current `team_task_plans` row, and
   * (when the task has a feature pipeline) the most-recent run with its ordered sections — each
   * carrying its own archived `plan_md` — and phases. Returns null when the task doesn't exist for
   * this tenant.
   */
  async getPlan(teamId: string, taskId: number): Promise<PlanView | null> {
    const taskRows = await this.query<TaskRow>(
      `SELECT ${TASK_COLS} FROM team_tasks WHERE id = $1 AND team_id = $2`,
      [taskId, teamId],
    );
    const task = taskRows[0];
    if (!task) return null;

    const planRows = await this.query<PlanRow>(
      `SELECT id, task_id, employee, plan_md, lead_status, owner_status, pr_url, created_at, updated_at
       FROM team_task_plans WHERE team_id = $1 AND task_id = $2`,
      [teamId, taskId],
    );
    const currentPlan = planRows[0] ? toPlanRowView(planRows[0]) : null;

    const pipeline = await this.loadPipeline(teamId, taskId);

    return { task: toBoardTaskView(task), currentPlan, pipeline };
  }

  /** All board tasks for a tenant, newest-touched first. Powers the board dashboard. */
  async getBoard(teamId: string): Promise<BoardTaskView[]> {
    const rows = await this.query<TaskRow>(
      `SELECT ${TASK_COLS} FROM team_tasks WHERE team_id = $1 ORDER BY updated_at DESC LIMIT 500`,
      [teamId],
    );
    return rows.map(toBoardTaskView);
  }

  /** The most-recent pipeline run for a task, with its sections (+ archived plans) and phases. */
  private async loadPipeline(
    teamId: string,
    taskId: number,
  ): Promise<PipelineRunView | null> {
    const runRows = await this.query<RunRow>(
      `SELECT id, task_id, pipeline, kind, status, planning_substep, overview,
              active_section_id, section_index, phase_index, created_at, updated_at
       FROM pipeline_runs
       WHERE team_id = $1 AND task_id = $2
       ORDER BY updated_at DESC
       LIMIT 1`,
      [teamId, taskId],
    );
    const run = runRows[0];
    if (!run) return null;

    const [sectionRows, phaseRows] = await Promise.all([
      this.query<SectionRow>(
        `SELECT id, ordinal, name, brief, phase_role, status, plan_md, depends_on
         FROM pipeline_run_sections WHERE run_id = $1 ORDER BY ordinal ASC`,
        [run.id],
      ),
      this.query<PhaseRow>(
        `SELECT id, section_id, ordinal, plan_phase_id, title, status
         FROM pipeline_run_phases WHERE run_id = $1 ORDER BY ordinal ASC`,
        [run.id],
      ),
    ]);

    const phasesBySection = new Map<string, PhaseView[]>();
    for (const p of phaseRows) {
      const list = phasesBySection.get(p.section_id) ?? [];
      list.push({
        id: p.id,
        sectionId: p.section_id,
        ordinal: Number(p.ordinal),
        planPhaseId: Number(p.plan_phase_id),
        title: p.title,
        status: p.status,
      });
      phasesBySection.set(p.section_id, list);
    }

    const sections: SectionView[] = sectionRows.map((s) => ({
      id: s.id,
      ordinal: Number(s.ordinal),
      name: s.name,
      brief: s.brief,
      phaseRole: s.phase_role,
      status: s.status,
      planMd: s.plan_md,
      dependsOn: s.depends_on ?? [],
      phases: phasesBySection.get(s.id) ?? [],
    }));

    return {
      id: run.id,
      taskId: Number(run.task_id),
      pipeline: run.pipeline,
      kind: run.kind,
      status: run.status,
      planningSubstep: run.planning_substep,
      overview: run.overview,
      activeSectionId: run.active_section_id,
      sectionIndex: Number(run.section_index),
      phaseIndex: Number(run.phase_index),
      createdAt: toIso(run.created_at),
      updatedAt: toIso(run.updated_at),
      sections,
    };
  }
}
