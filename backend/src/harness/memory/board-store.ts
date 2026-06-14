import { TeamTask as TeamTaskEntity } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';
import type { BoardEventsBus } from './board-events.bus';
import { rawRows, toIso } from './sql';

/**
 * The TEAM BOARD — shared, deliberate work items the team coordinates on, distinct from the
 * per-employee reminder plate (TaskStore). The lead creates/assigns when dispatching; teammates
 * claim unassigned items. Claiming is ATOMIC at the DB (one conditional UPDATE — the DB plays the
 * role of a claim lock), and `blocked` is DERIVED from `depends_on` inside that same statement, so
 * completing a task never fans out writes to its dependents.
 *
 * Lifecycle (the approval layer rides on status): open → claim → planning (the planning session +
 * its Q&A) → awaiting_approval (plan posted for Dennis) → approved (TEAM LEAD only, recorded on
 * Dennis's explicit word at a planning sitting) → executing (an execute session opened — the
 * approved→executing CAS lives in CreateSessionTool) → self_review (all owners done; the harness's
 * task-level integration review on the shared branch) → in_review (PR marked ready, waiting on
 * Dennis) → done. An APPROVED ticket stays the owner's to execute and re-execute: review feedback
 * loops in 'in_review' with NO re-approval (the original approval covers it), and only Dennis's
 * acceptance (clerked by the lead) advances 'in_review' → 'done'. claim() takes only 'open' tasks,
 * and only 'done' satisfies a dependency — both unchanged by the in-between states.
 *
 * Per-owner execution detail (which owner has finished its own self-review, the execute worktree,
 * the shared branch) lives on the plan row (PlanStore), NOT the task: a multi-owner ticket stays
 * 'executing' until every plan row is 'complete', then the integration barrier flips it.
 */
export type BoardStatus =
  | 'open'
  | 'planning'
  | 'awaiting_approval'
  | 'approved'
  | 'executing'
  | 'self_review'
  | 'in_review'
  | 'done';

/** Task statuses that represent active, in-flight work — what FetchService injects into bot context
 * and what the execution throttle counts. */
export const ACTIVE_BOARD_STATUSES: readonly BoardStatus[] = [
  'planning',
  'executing',
  'self_review',
];

/** The in-flight execution statuses the throttle counts against its concurrency cap. */
export const IN_FLIGHT_EXECUTION_STATUSES: readonly BoardStatus[] = [
  'executing',
  'self_review',
];

export interface BoardTask {
  id: number;
  project: string;
  title: string;
  description: string;
  status: BoardStatus;
  assignee?: string;
  createdBy: string;
  dependsOn: number[];
  createdAt: string;
  updatedAt: string;
}

export interface NewBoardTask {
  team: string;
  project: string;
  title: string;
  description?: string;
  assignee?: string;
  createdBy: string;
  dependsOn?: number[];
}

export interface ListBoardQuery {
  team: string;
  project?: string;
  assignee?: string;
  status?: BoardStatus | readonly BoardStatus[];
  limit?: number;
}

export type ClaimRefusal = 'taken' | 'blocked' | 'missing';

interface BoardRow {
  id: number | string;
  project: string;
  title: string;
  description: string;
  status: BoardStatus;
  assignee: string | null;
  created_by: string;
  depends_on: number[];
  created_at: unknown;
  updated_at: unknown;
}

const toBoardTask = (r: BoardRow): BoardTask => ({
  id: Number(r.id),
  project: r.project,
  title: r.title,
  description: r.description,
  status: r.status,
  assignee: r.assignee ?? undefined,
  createdBy: r.created_by,
  dependsOn: (r.depends_on ?? []).map(Number),
  createdAt: toIso(r.created_at),
  updatedAt: toIso(r.updated_at),
});

export class BoardStore {
  // `events` is optional so tests can `new BoardStore(repo)` without the bus; production wires it
  // via the MemoryModule factory.
  constructor(
    private readonly repo: Repository<TeamTaskEntity>,
    private readonly events?: BoardEventsBus,
  ) {}

  private async q(sql: string, params: unknown[]): Promise<BoardRow[]> {
    return rawRows<BoardRow>(await this.repo.manager.query(sql, params));
  }

  /** Fire `ticket-approved` when a write lands a task in 'approved' — both the CAS path (the Slack
   * approval card → transition) and the manual path (a lead's update_board_task → update) funnel
   * through here, so the owner is woken to execute no matter how the verdict arrived. */
  private announceIfApproved(team: string, task: BoardTask | undefined): void {
    if (task?.status === 'approved')
      this.events?.emit({ kind: 'ticket-approved', team, taskId: task.id });
  }

  /**
   * Create a board task. Unknown `dependsOn` ids (not on this team's board) are rejected — a typo'd
   * dependency would otherwise block the task forever.
   */
  async create(
    t: NewBoardTask,
  ): Promise<BoardTask | { unknownDeps: number[] }> {
    const deps = [...new Set(t.dependsOn ?? [])];
    if (deps.length > 0) {
      const known = await this.q(
        `SELECT id FROM team_tasks WHERE team_id = $1 AND id = ANY($2)`,
        [t.team, deps],
      );
      const knownIds = new Set(known.map((r) => Number(r.id)));
      const unknownDeps = deps.filter((d) => !knownIds.has(d));
      if (unknownDeps.length > 0) return { unknownDeps };
    }
    const rows = await this.q(
      `INSERT INTO team_tasks (team_id, project, title, description, status, assignee, created_by, depends_on, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'open', $5, $6, $7, now(), now())
       RETURNING *`,
      [
        t.team,
        t.project,
        t.title,
        t.description ?? '',
        t.assignee ?? null,
        t.createdBy,
        deps,
      ],
    );
    return toBoardTask(rows[0]);
  }

  /**
   * Atomically claim a task and start it: open, unassigned (or pre-assigned to this bot), and with
   * every dependency done. The single conditional UPDATE is the claim lock — two simultaneous
   * claimants can't both win. On refusal, a follow-up read names WHY for the tool message.
   */
  async claim(
    team: string,
    id: number,
    botId: string,
  ): Promise<BoardTask | ClaimRefusal> {
    const rows = await this.q(
      `UPDATE team_tasks t SET assignee = $3, status = 'planning', updated_at = now()
       WHERE t.id = $1 AND t.team_id = $2 AND t.status = 'open'
         AND (t.assignee IS NULL OR t.assignee = $3)
         AND NOT EXISTS (SELECT 1 FROM team_tasks d
                         WHERE d.team_id = t.team_id AND d.id = ANY(t.depends_on) AND d.status <> 'done')
       RETURNING *`,
      [id, team, botId],
    );
    if (rows[0]) return toBoardTask(rows[0]);
    const existing = await this.get(team, id);
    if (!existing) return 'missing';
    if (
      existing.status !== 'open' ||
      (existing.assignee && existing.assignee !== botId)
    )
      return 'taken';
    return 'blocked';
  }

  /**
   * Atomic compare-and-set status transition — the claim() idiom (one conditional UPDATE, the DB
   * is the lock). The verdict handler's guard against double clicks and stale approval cards: two
   * concurrent verdicts on one task, exactly one wins; the loser reads the task to say why.
   */
  async transition(
    team: string,
    id: number,
    from: BoardStatus,
    patch: { status: BoardStatus; assignee?: string | null },
  ): Promise<BoardTask | undefined> {
    const sets = ['status = $4', 'updated_at = now()'];
    const args: unknown[] = [id, team, from, patch.status];
    if (patch.assignee !== undefined) {
      args.push(patch.assignee);
      sets.push(`assignee = $${args.length}`);
    }
    const rows = await this.q(
      `UPDATE team_tasks SET ${sets.join(', ')} WHERE id = $1 AND team_id = $2 AND status = $3 RETURNING *`,
      args,
    );
    const task = rows[0] ? toBoardTask(rows[0]) : undefined;
    this.announceIfApproved(team, task);
    return task;
  }

  /** Guarded field update — AUTHORITY IS THE TOOL'S JOB; this only enforces team + existence. */
  async update(
    team: string,
    id: number,
    patch: {
      status?: BoardStatus;
      assignee?: string | null;
      title?: string;
      description?: string;
    },
  ): Promise<BoardTask | undefined> {
    const sets: string[] = ['updated_at = now()'];
    const args: unknown[] = [id, team];
    const set = (col: string, v: unknown) => {
      args.push(v);
      sets.push(`${col} = $${args.length}`);
    };
    if (patch.status !== undefined) set('status', patch.status);
    if (patch.assignee !== undefined) set('assignee', patch.assignee);
    if (patch.title !== undefined) set('title', patch.title);
    if (patch.description !== undefined) set('description', patch.description);
    const rows = await this.q(
      `UPDATE team_tasks SET ${sets.join(', ')} WHERE id = $1 AND team_id = $2 RETURNING *`,
      args,
    );
    const task = rows[0] ? toBoardTask(rows[0]) : undefined;
    if (patch.status === 'approved') this.announceIfApproved(team, task);
    return task;
  }

  /** A single board task by id within a team (for authority checks), or undefined. */
  async get(team: string, id: number): Promise<BoardTask | undefined> {
    const rows = await this.q(
      `SELECT * FROM team_tasks WHERE id = $1 AND team_id = $2`,
      [id, team],
    );
    return rows[0] ? toBoardTask(rows[0]) : undefined;
  }

  /** Board view, oldest first (work queue order), with optional filters. */
  async list(query: ListBoardQuery): Promise<BoardTask[]> {
    const where = ['team_id = $1'];
    const args: unknown[] = [query.team];
    const and = (clause: (n: number) => string, v: unknown) => {
      args.push(v);
      where.push(clause(args.length));
    };
    if (query.project) and((n) => `project = $${n}`, query.project);
    if (query.assignee) and((n) => `assignee = $${n}`, query.assignee);
    if (query.status)
      Array.isArray(query.status)
        ? and((n) => `status = ANY($${n})`, [...query.status])
        : and((n) => `status = $${n}`, query.status);
    args.push(query.limit ?? 50);
    const rows = await this.q(
      `SELECT * FROM team_tasks WHERE ${where.join(' AND ')} ORDER BY created_at ASC LIMIT $${args.length}`,
      args,
    );
    return rows.map(toBoardTask);
  }

  /** How many of this team's tasks are in-flight execution (executing + self_review) — the count the
   * execution throttle weighs against its concurrency cap. */
  async countInFlightExecution(team: string): Promise<number> {
    const rows = await this.repo.manager.query(
      `SELECT count(*)::int AS n FROM team_tasks WHERE team_id = $1 AND status = ANY($2)`,
      [team, [...IN_FLIGHT_EXECUTION_STATUSES]],
    );
    return Number(rawRows<{ n: number }>(rows)[0]?.n ?? 0);
  }

  /**
   * Incomplete dependencies per task, in one batch query (no N+1 from list_board): task id →
   * the not-yet-done ids it waits on. Tasks with no open blockers are absent from the map.
   */
  async blockersOf(
    team: string,
    tasks: BoardTask[],
  ): Promise<Map<number, number[]>> {
    const blocked = new Map<number, number[]>();
    const withDeps = tasks.filter((t) => t.dependsOn.length > 0);
    if (withDeps.length === 0) return blocked;
    const rows = await this.q(
      `SELECT id FROM team_tasks WHERE team_id = $1 AND id = ANY($2) AND status <> 'done'`,
      [team, [...new Set(withDeps.flatMap((t) => t.dependsOn))]],
    );
    const open = new Set(rows.map((r) => Number(r.id)));
    for (const t of withDeps) {
      const blockers = t.dependsOn.filter((d) => open.has(d));
      if (blockers.length > 0) blocked.set(t.id, blockers);
    }
    return blocked;
  }
}
