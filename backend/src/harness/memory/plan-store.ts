import { TeamTaskPlan as TeamTaskPlanEntity } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';
import { rawRows, toIso } from './sql';

/**
 * Per-employee plans attached to TEAM BOARD tasks — the DURABLE artifact of a planning session.
 * The runner auto-attaches a board-linked session's finished plan here (latest version wins per
 * (team, task, employee)); the team lead reviews each attached plan (`lead_status`), and only a
 * ticket whose plans are ALL lead-approved can be proposed to Dennis. Re-attaching a revised plan
 * RESETS lead_status to 'pending' inside the same upsert — a changed plan needs the lead again.
 */
export type PlanLeadStatus = 'pending' | 'approved';

export interface TaskPlan {
  id: number;
  taskId: number;
  employee: string;
  planMd: string;
  leadStatus: PlanLeadStatus;
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
}

interface PlanRow {
  id: number | string;
  task_id: number | string;
  employee: string;
  plan_md: string;
  lead_status: PlanLeadStatus;
  session_id: string | null;
  created_at: unknown;
  updated_at: unknown;
}

const toPlan = (r: PlanRow): TaskPlan => ({
  id: Number(r.id),
  taskId: Number(r.task_id),
  employee: r.employee,
  planMd: r.plan_md,
  leadStatus: r.lead_status,
  sessionId: r.session_id ?? undefined,
  createdAt: toIso(r.created_at),
  updatedAt: toIso(r.updated_at),
});

export class PlanStore {
  constructor(private readonly repo: Repository<TeamTaskPlanEntity>) {}

  private async q(sql: string, params: unknown[]): Promise<PlanRow[]> {
    return rawRows<PlanRow>(await this.repo.manager.query(sql, params));
  }

  /** Upsert on (team, task, employee) — latest plan wins, and the lead's prior approval is reset. */
  async attach(p: {
    team: string;
    taskId: number;
    employee: string;
    planMd: string;
    sessionId?: string;
  }): Promise<TaskPlan> {
    const rows = await this.q(
      `INSERT INTO team_task_plans (team_id, task_id, employee, plan_md, session_id, lead_status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', now(), now())
       ON CONFLICT (team_id, task_id, employee)
       DO UPDATE SET plan_md = $4, session_id = $5, lead_status = 'pending', updated_at = now()
       RETURNING *`,
      [p.team, p.taskId, p.employee, p.planMd, p.sessionId ?? null],
    );
    return toPlan(rows[0]);
  }

  async get(
    team: string,
    taskId: number,
    employee: string,
  ): Promise<TaskPlan | undefined> {
    const rows = await this.q(
      `SELECT * FROM team_task_plans WHERE team_id = $1 AND task_id = $2 AND employee = $3`,
      [team, taskId, employee],
    );
    return rows[0] ? toPlan(rows[0]) : undefined;
  }

  /** Every plan on a task, employee order (stable reading order for review and the card thread). */
  async listForTask(team: string, taskId: number): Promise<TaskPlan[]> {
    const rows = await this.q(
      `SELECT * FROM team_task_plans WHERE team_id = $1 AND task_id = $2 ORDER BY employee ASC`,
      [team, taskId],
    );
    return rows.map(toPlan);
  }

  /** The lead's sign-off on the CURRENT version of an employee's plan. */
  async approve(
    team: string,
    taskId: number,
    employee: string,
  ): Promise<TaskPlan | undefined> {
    const rows = await this.q(
      `UPDATE team_task_plans SET lead_status = 'approved', updated_at = now()
       WHERE team_id = $1 AND task_id = $2 AND employee = $3
       RETURNING *`,
      [team, taskId, employee],
    );
    return rows[0] ? toPlan(rows[0]) : undefined;
  }
}
