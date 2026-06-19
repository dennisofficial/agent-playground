import { Task as TaskEntity } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';
import { rawRows, toIso } from './sql';

/**
 * Per-employee REMINDERS (the personal "plate"). Owned by exactly one employee; project-scoped; plain
 * SQL, no embeddings. Open-dedup is per (project, owner, norm), enforced by the unique partial index.
 * Ported from playground/src/memory/tasks.ts.
 */
export type TaskStatus = 'open' | 'done' | 'dropped';

export interface Task {
  id: number;
  project: string;
  description: string;
  owner: string;
  createdBy?: string;
  status: TaskStatus;
  source?: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewTask {
  team: string;
  project: string;
  description: string;
  owner: string;
  createdBy?: string;
  source?: string;
}

export interface ListTasksQuery {
  team: string;
  project: string;
  status?: TaskStatus;
  owner?: string;
  limit?: number;
}

/** Dedup key: lowercased, whitespace-collapsed. Matches the `norm` column the unique index covers. */
const normalize = (s: string): string =>
  s.toLowerCase().replace(/\s+/g, ' ').trim();

interface TaskRow {
  id: number | string;
  project: string;
  description: string;
  owner: string;
  created_by: string | null;
  status: TaskStatus;
  source: string | null;
  created_at: unknown;
  updated_at: unknown;
}

const toTask = (r: TaskRow): Task => ({
  id: Number(r.id),
  project: r.project,
  description: r.description,
  owner: r.owner,
  createdBy: r.created_by ?? undefined,
  status: r.status,
  source: r.source ?? undefined,
  createdAt: toIso(r.created_at),
  updatedAt: toIso(r.updated_at),
});

export class TaskStore {
  constructor(private readonly repo: Repository<TaskEntity>) {}

  private async q(sql: string, params: unknown[]): Promise<TaskRow[]> {
    return rawRows<TaskRow>(await this.repo.manager.query(sql, params));
  }

  /**
   * Add a reminder to someone's plate. A duplicate OPEN reminder on the same plate (project + owner +
   * normalized description) is a silent no-op via the unique partial index. Returns the new row, or
   * undefined on dedup.
   */
  async addTask(t: NewTask): Promise<Task | undefined> {
    const rows = await this.q(
      `INSERT INTO tasks (team_id, project, description, norm, owner, created_by, status, source, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, now(), now())
       ON CONFLICT (team_id, project, owner, norm) WHERE status = 'open' DO NOTHING
       RETURNING *`,
      [
        t.team,
        t.project,
        t.description,
        normalize(t.description),
        t.owner,
        t.createdBy ?? null,
        t.source ?? null,
      ],
    );
    return rows[0] ? toTask(rows[0]) : undefined;
  }

  /** Reminders for a workspace, newest first, optionally filtered by status / owner. */
  async listTasks(query: ListTasksQuery): Promise<Task[]> {
    const where = ['team_id = $1', 'project = $2'];
    const args: unknown[] = [query.team, query.project];
    if (query.status) {
      args.push(query.status);
      where.push(`status = $${args.length}`);
    }
    if (query.owner) {
      args.push(query.owner);
      where.push(`owner = $${args.length}`);
    }
    args.push(query.limit ?? 50);
    const rows = await this.q(
      `SELECT * FROM tasks WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT $${args.length}`,
      args,
    );
    return rows.map(toTask);
  }

  /** All open reminders for a workspace (oldest first) — the team-lead / standup whole-board view. */
  async openTasks(team: string, project: string): Promise<Task[]> {
    const rows = await this.q(
      `SELECT * FROM tasks WHERE team_id = $1 AND project = $2 AND status = 'open' ORDER BY created_at ASC`,
      [team, project],
    );
    return rows.map(toTask);
  }

  /** Open reminders relevant to one bot's turn: on its plate OR raised by it. Oldest first. */
  async remindersForBot(
    team: string,
    project: string,
    botId: string,
  ): Promise<Task[]> {
    const rows = await this.q(
      `SELECT * FROM tasks WHERE team_id = $1 AND project = $2 AND status = 'open' AND (owner = $3 OR created_by = $3)
       ORDER BY created_at ASC`,
      [team, project, botId],
    );
    return rows.map(toTask);
  }

  /** A single reminder by id within a workspace+project (for authority checks), or undefined. */
  async getTask(
    team: string,
    project: string,
    id: number,
  ): Promise<Task | undefined> {
    const rows = await this.q(
      `SELECT * FROM tasks WHERE id = $1 AND team_id = $2 AND project = $3`,
      [id, team, project],
    );
    return rows[0] ? toTask(rows[0]) : undefined;
  }

  /** Mark a task done. Workspace+project-enforced so an id can't close another's task. */
  completeTask(team: string, project: string, id: number): Promise<boolean> {
    return this.setStatus(team, project, id, 'done');
  }

  /** Drop a task (no longer relevant). Workspace+project-enforced. */
  dropTask(team: string, project: string, id: number): Promise<boolean> {
    return this.setStatus(team, project, id, 'dropped');
  }

  /**
   * Re-key this team's reminders from one project to another — used when a channel's main repo is
   * linked during onboarding and its project id changes, so pre-link reminders stay visible under the
   * new project. Returns the number of rows moved. The target project is freshly registered (empty) at
   * link time, so the open-dedup unique index can't collide.
   */
  async reproject(team: string, from: string, to: string): Promise<number> {
    if (from === to) return 0;
    const rows = await this.q(
      `UPDATE tasks SET project = $3, updated_at = now() WHERE team_id = $1 AND project = $2 RETURNING id`,
      [team, from, to],
    );
    return rows.length;
  }

  private async setStatus(
    team: string,
    project: string,
    id: number,
    status: TaskStatus,
  ): Promise<boolean> {
    const rows = await this.q(
      `UPDATE tasks SET status = $1, updated_at = now() WHERE id = $2 AND team_id = $3 AND project = $4 RETURNING id`,
      [status, id, team, project],
    );
    return rows.length > 0;
  }
}
