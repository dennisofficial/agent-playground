import { TeamTaskPlan as TeamTaskPlanEntity } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';
import type { BoardEventsBus } from './board-events.bus';
import { rawRows, toIso } from './sql';

/**
 * The plan attached to a TEAM BOARD task — the DURABLE artifact of a planning session. ONE plan per
 * task (latest version wins per (team, task)); the `employee` column records the authoring role only.
 * The lead reviews the attached plan (`lead_status`), and only a lead-approved ticket can be proposed
 * to Dennis. Re-attaching a revised plan RESETS lead_status to 'pending' inside the same upsert — a
 * changed plan needs the lead again.
 */
export type PlanLeadStatus = 'pending' | 'approved';

/**
 * The plan-review state of a board task — derived from `team_task_plans`, a pure plan-review axis
 * entirely separate from the board status (Dennis-approval lives in `status`) and from the
 * EXECUTION axis (`PlanOwnerStatus`).
 * - 'none'           — no plan attached yet.
 * - 'pending_review' — a plan is attached but not yet lead-approved.
 * - 'lead_approved'  — the attached plan has been lead-approved.
 */
export type PlanState = 'none' | 'pending_review' | 'lead_approved';

/** Execution state on the plan row — see TeamTaskPlan.owner_status. */
export type PlanOwnerStatus = 'executing' | 'reviewed' | 'complete' | 'blocked';

export interface TaskPlan {
  id: number;
  taskId: number;
  employee: string;
  planMd: string;
  leadStatus: PlanLeadStatus;
  sessionId?: string;
  ownerStatus: PlanOwnerStatus;
  executeWorkspaceId?: string;
  sharedBranch?: string;
  prUrl?: string;
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
  owner_status: PlanOwnerStatus;
  execute_workspace_id: string | null;
  shared_branch: string | null;
  pr_url: string | null;
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
  ownerStatus: r.owner_status,
  executeWorkspaceId: r.execute_workspace_id ?? undefined,
  sharedBranch: r.shared_branch ?? undefined,
  prUrl: r.pr_url ?? undefined,
  createdAt: toIso(r.created_at),
  updatedAt: toIso(r.updated_at),
});

export class PlanStore {
  // `events` is optional so tests can `new PlanStore(repo)` without the bus; production wires it
  // via the MemoryModule factory.
  constructor(
    private readonly repo: Repository<TeamTaskPlanEntity>,
    private readonly events?: BoardEventsBus,
  ) {}

  private async q<R = PlanRow>(sql: string, params: unknown[]): Promise<R[]> {
    return rawRows<R>(await this.repo.manager.query(sql, params));
  }

  /** Upsert on (team, task) — latest plan wins (overwriting any prior author's row), and the lead's
   * prior approval is reset. The `employee` field records who authored THIS version. */
  async attach(p: {
    team: string;
    taskId: number;
    employee: string;
    planMd: string;
    sessionId?: string;
  }): Promise<TaskPlan> {
    const rows = await this.q(
      // A re-attached (revised) plan resets BOTH gates: lead_status → 'pending' (the lead re-reviews)
      // and owner_status → 'executing' (any prior execution/self-review state is stale for new work).
      // The conflict target is (team, task): one plan per task, so a fresh author overwrites.
      `INSERT INTO team_task_plans (team_id, task_id, employee, plan_md, session_id, lead_status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', now(), now())
       ON CONFLICT (team_id, task_id)
       DO UPDATE SET employee = $3, plan_md = $4, session_id = $5, lead_status = 'pending', owner_status = 'executing', updated_at = now()
       RETURNING *`,
      [p.team, p.taskId, p.employee, p.planMd, p.sessionId ?? null],
    );
    const plan = toPlan(rows[0]);
    // Wake the lead to review — re-attach resets lead_status to 'pending', so a revised plan earns
    // a fresh review.
    this.events?.emit({
      kind: 'plan-attached',
      team: p.team,
      taskId: p.taskId,
      employee: p.employee,
      sessionId: p.sessionId,
    });
    return plan;
  }

  /** The single plan attached to a task (or undefined). */
  async get(team: string, taskId: number): Promise<TaskPlan | undefined> {
    const rows = await this.q(
      `SELECT * FROM team_task_plans WHERE team_id = $1 AND task_id = $2`,
      [team, taskId],
    );
    return rows[0] ? toPlan(rows[0]) : undefined;
  }

  /** The plan on a task as a list (0 or 1 rows) — kept for callers that render plan blocks. */
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

  /**
   * Batch plan-review state for a set of task ids — one grouped query, no N+1.
   * Tasks with no plans are absent from the result (callers treat absent as 'none').
   * Mirrors the `BoardStore.blockersOf` pattern.
   */
  async planStatesOf(
    team: string,
    taskIds: number[],
  ): Promise<Map<number, PlanState>> {
    const out = new Map<number, PlanState>();
    const ids = [...new Set(taskIds)];
    if (ids.length === 0) return out;
    const rows = await this.q<{
      task_id: number | string;
      pending: number | string;
    }>(
      `SELECT task_id, count(*) FILTER (WHERE lead_status <> 'approved') AS pending
         FROM team_task_plans
        WHERE team_id = $1 AND task_id = ANY($2)
        GROUP BY task_id`,
      [team, ids],
    );
    for (const r of rows)
      out.set(
        Number(r.task_id),
        Number(r.pending) > 0 ? 'pending_review' : 'lead_approved',
      );
    return out;
  }

  /** Stamp the execute context (workspace + shared branch) onto the task's plan row at execute-session
   * start, so the integration barrier can find them later. Idempotent. */
  async setExecuteContext(
    team: string,
    taskId: number,
    ctx: { executeWorkspaceId: string; sharedBranch?: string },
  ): Promise<TaskPlan | undefined> {
    const rows = await this.q(
      `UPDATE team_task_plans
         SET execute_workspace_id = $3, shared_branch = $4, updated_at = now()
       WHERE team_id = $1 AND task_id = $2
       RETURNING *`,
      [team, taskId, ctx.executeWorkspaceId, ctx.sharedBranch ?? null],
    );
    return rows[0] ? toPlan(rows[0]) : undefined;
  }

  /** Move the task's execution state ('executing' → 'blocked'/'reviewed'/'complete'). */
  async setOwnerStatus(
    team: string,
    taskId: number,
    ownerStatus: PlanOwnerStatus,
  ): Promise<TaskPlan | undefined> {
    const rows = await this.q(
      `UPDATE team_task_plans SET owner_status = $3, updated_at = now()
       WHERE team_id = $1 AND task_id = $2
       RETURNING *`,
      [team, taskId, ownerStatus],
    );
    return rows[0] ? toPlan(rows[0]) : undefined;
  }

  /** Record the task-level PR url on the task's plan row. */
  async setPrUrl(team: string, taskId: number, prUrl: string): Promise<void> {
    await this.q(
      `UPDATE team_task_plans SET pr_url = $3, updated_at = now()
       WHERE team_id = $1 AND task_id = $2`,
      [team, taskId, prUrl],
    );
  }
}
