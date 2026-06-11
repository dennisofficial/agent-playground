import { Worklog as WorklogEntity } from '@workspace/shared/schemas';
import { Repository } from 'typeorm';
import { rawRows, toIso } from './sql';

/**
 * The work log — a durable, time-ordered record of completed background work ("what did you do
 * yesterday?"). Distinct from semantic facts ("what's true now"). Project-scoped. Plain SQL.
 * Ported from playground/src/memory/worklog.ts.
 */
export interface WorkEntry {
  team: string;
  ownerBot: string;
  project: string;
  task: string;
  summary: string;
  completedAt: string;
}

export interface RecentWorkQuery {
  team: string;
  project: string;
  ownerBot?: string;
  since?: string;
  limit?: number;
}

interface WorklogRow {
  team_id: string;
  owner_bot: string;
  project: string;
  task: string;
  summary: string;
  completed_at: unknown;
}

export class WorklogStore {
  constructor(private readonly repo: Repository<WorklogEntity>) {}

  private async q(sql: string, params: unknown[]): Promise<WorklogRow[]> {
    return rawRows<WorklogRow>(await this.repo.manager.query(sql, params));
  }

  /** Record a completed unit of work. Called when a background job finishes. */
  async logWork(e: Omit<WorkEntry, 'completedAt'>): Promise<void> {
    await this.q(
      `INSERT INTO worklog (team_id, owner_bot, project, task, summary, completed_at) VALUES ($1, $2, $3, $4, $5, now())`,
      [e.team, e.ownerBot, e.project, e.task, e.summary],
    );
  }

  /** Recent completed work, newest first, scoped to a workspace+project (and optionally bot / window). */
  async recentWork(query: RecentWorkQuery): Promise<WorkEntry[]> {
    const where = ['team_id = $1', 'project = $2'];
    const args: unknown[] = [query.team, query.project];
    if (query.ownerBot) {
      args.push(query.ownerBot);
      where.push(`owner_bot = $${args.length}`);
    }
    if (query.since) {
      args.push(query.since);
      where.push(`completed_at >= $${args.length}`);
    }
    args.push(query.limit ?? 10);
    const rows = await this.q(
      `SELECT team_id, owner_bot, project, task, summary, completed_at FROM worklog
       WHERE ${where.join(' AND ')} ORDER BY completed_at DESC LIMIT $${args.length}`,
      args,
    );
    return rows.map((r) => ({
      team: r.team_id,
      ownerBot: r.owner_bot,
      project: r.project,
      task: r.task,
      summary: r.summary,
      completedAt: toIso(r.completed_at),
    }));
  }
}
