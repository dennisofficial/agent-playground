import { TeamTaskPlan as TeamTaskPlanEntity } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';
import type { BoardEventsBus } from './board-events.bus';
import { rawRows, toIso } from './sql';

/**
 * Per-employee plans attached to TEAM BOARD tasks — the DURABLE artifact of a planning session.
 * The runner auto-attaches a board-linked session's finished plan here (latest version wins per
 * (team, task, employee)); the team lead reviews each attached plan (`lead_status`), and only a
 * ticket whose plans are ALL lead-approved can be proposed to Dennis. Re-attaching a revised plan
 * RESETS lead_status to 'pending' inside the same upsert — a changed plan needs the lead again.
 */
export type PlanLeadStatus = 'pending' | 'approved';

/**
 * The plan-review state of a board task — derived from `team_task_plans`, a pure plan-review axis
 * entirely separate from the board status (Dennis-approval lives in `status`) and from the per-owner
 * EXECUTION axis (`PlanOwnerStatus`).
 * - 'none'           — no plan attached yet.
 * - 'pending_review' — at least one plan is attached but not yet lead-approved.
 * - 'lead_approved'  — every attached plan has been lead-approved.
 */
export type PlanState = 'none' | 'pending_review' | 'lead_approved';

/** Per-owner execution state on the plan row — see TeamTaskPlan.owner_status. */
export type PlanOwnerStatus = 'executing' | 'reviewed' | 'complete' | 'blocked';

export interface TaskPlan {
  id: number;
  taskId: number;
  employee: string;
  planMd: string;
  leadStatus: PlanLeadStatus;
  sessionId?: string;
  ownerStatus: PlanOwnerStatus;
  executeWorktreeId?: string;
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
  execute_worktree_id: string | null;
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
  executeWorktreeId: r.execute_worktree_id ?? undefined,
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

  /** Upsert on (team, task, employee) — latest plan wins, and the lead's prior approval is reset. */
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
      `INSERT INTO team_task_plans (team_id, task_id, employee, plan_md, session_id, lead_status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', now(), now())
       ON CONFLICT (team_id, task_id, employee)
       DO UPDATE SET plan_md = $4, session_id = $5, lead_status = 'pending', owner_status = 'executing', updated_at = now()
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

  /** Stamp the execute context (worktree + shared branch) onto an owner's plan row at execute-session
   * start, so the integration barrier can find them later. Idempotent. */
  async setExecuteContext(
    team: string,
    taskId: number,
    employee: string,
    ctx: { executeWorktreeId: string; sharedBranch?: string },
  ): Promise<TaskPlan | undefined> {
    const rows = await this.q(
      `UPDATE team_task_plans
         SET execute_worktree_id = $4, shared_branch = $5, updated_at = now()
       WHERE team_id = $1 AND task_id = $2 AND employee = $3
       RETURNING *`,
      [team, taskId, employee, ctx.executeWorktreeId, ctx.sharedBranch ?? null],
    );
    return rows[0] ? toPlan(rows[0]) : undefined;
  }

  /** Move an owner's per-owner execution state ('executing' → 'blocked'/'reviewed'/'complete'). */
  async setOwnerStatus(
    team: string,
    taskId: number,
    employee: string,
    ownerStatus: PlanOwnerStatus,
  ): Promise<TaskPlan | undefined> {
    const rows = await this.q(
      `UPDATE team_task_plans SET owner_status = $4, updated_at = now()
       WHERE team_id = $1 AND task_id = $2 AND employee = $3
       RETURNING *`,
      [team, taskId, employee, ownerStatus],
    );
    return rows[0] ? toPlan(rows[0]) : undefined;
  }

  /** Record the task-level PR url on the task's plan row(s) (one owner per ticket; stamping by task
   * keeps the lookup uniform regardless of which row is read). */
  async setPrUrl(team: string, taskId: number, prUrl: string): Promise<void> {
    await this.q(
      `UPDATE team_task_plans SET pr_url = $3, updated_at = now()
       WHERE team_id = $1 AND task_id = $2`,
      [team, taskId, prUrl],
    );
  }

  /** True when every plan row on the task is 'complete' — the integration barrier's gate. With no
   * plans the task can't be in execution, so an empty set is NOT complete. */
  async allOwnersComplete(team: string, taskId: number): Promise<boolean> {
    const plans = await this.listForTask(team, taskId);
    return plans.length > 0 && plans.every((p) => p.ownerStatus === 'complete');
  }
}
