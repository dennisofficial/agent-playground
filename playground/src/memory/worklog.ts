import { getDb } from './db.js';

/**
 * The work log — a durable, time-ordered record of completed background work, so "what did you do
 * yesterday?" has a real answer that survives restarts. Distinct from semantic facts (which are
 * "what's true now"): this is "what happened, and when". Scoped by `project` (the workspace), so a
 * standup in one project never surfaces another's work. Plain SQL — no embeddings needed.
 */
export interface WorkEntry {
  ownerBot: string;
  project: string;
  task: string;
  summary: string;
  completedAt: string;
}

interface Row {
  owner_bot: string;
  project: string;
  task: string;
  summary: string;
  completed_at: string;
}

/** Record a completed unit of work. Called when a background job finishes. */
export function logWork(e: Omit<WorkEntry, 'completedAt'>): void {
  getDb()
    .prepare(
      `INSERT INTO worklog (owner_bot, project, task, summary, completed_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(e.ownerBot, e.project, e.task, e.summary, new Date().toISOString());
}

export interface RecentWorkQuery {
  project: string;
  /** Omit for the whole team's work; set to scope to one bot ("what did *I* do"). */
  ownerBot?: string;
  /** ISO cutoff; omit for "all time". */
  since?: string;
  limit?: number;
}

/** Recent completed work, newest first, scoped to a project (and optionally one bot / time window). */
export function recentWork(q: RecentWorkQuery): WorkEntry[] {
  const where = ['project = ?'];
  const args: unknown[] = [q.project];
  if (q.ownerBot) {
    where.push('owner_bot = ?');
    args.push(q.ownerBot);
  }
  if (q.since) {
    where.push('completed_at >= ?');
    args.push(q.since);
  }
  const rows = getDb()
    .prepare(
      `SELECT owner_bot, project, task, summary, completed_at FROM worklog
       WHERE ${where.join(' AND ')} ORDER BY completed_at DESC LIMIT ?`,
    )
    .all(...args, q.limit ?? 10) as Row[];
  return rows.map((r) => ({
    ownerBot: r.owner_bot,
    project: r.project,
    task: r.task,
    summary: r.summary,
    completedAt: r.completed_at,
  }));
}
