import { getDb } from './db.js';

/**
 * The internal task board — open handoffs and todos so a commitment made in passing ("you'll wire the
 * tracking hooks once the API's up") doesn't evaporate into the chat scrollback. Sibling to `worklog`:
 * that's "what got done", this is "what still needs doing". Scoped by `company` (the workspace), plain
 * SQL — no embeddings. The reflect pass writes here; the task tools read/close. Dedup of OPEN tasks is
 * enforced by a unique partial index in [db.ts](db.ts), so concurrent writers can't double-insert.
 */
export type TaskStatus = 'open' | 'done' | 'dropped';

export interface Task {
  id: number;
  company: string;
  description: string;
  assignee?: string;
  createdBy?: string;
  status: TaskStatus;
  source?: string;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: number;
  company: string;
  description: string;
  assignee: string | null;
  created_by: string | null;
  status: TaskStatus;
  source: string | null;
  created_at: string;
  updated_at: string;
}

const toTask = (r: Row): Task => ({
  id: r.id,
  company: r.company,
  description: r.description,
  assignee: r.assignee ?? undefined,
  createdBy: r.created_by ?? undefined,
  status: r.status,
  source: r.source ?? undefined,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** The dedup key: lowercased, whitespace-collapsed. Matches the `norm` column the unique index covers. */
const normalize = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

export interface NewTask {
  company: string;
  description: string;
  assignee?: string;
  createdBy?: string;
  source?: string;
}

/**
 * Add an open task. A duplicate of an existing OPEN task (same company + normalized description) is a
 * silent no-op via the unique partial index — `ON CONFLICT DO NOTHING` — so two bots reflecting on the
 * same handoff don't both insert it. Returns the new row, or undefined when it was a dedup no-op.
 */
export function addTask(t: NewTask): Task | undefined {
  const now = new Date().toISOString();
  const info = getDb()
    .prepare(
      `INSERT INTO tasks (company, description, norm, assignee, created_by, status, source, created_at, updated_at)
       VALUES (@company, @description, @norm, @assignee, @createdBy, 'open', @source, @now, @now)
       ON CONFLICT DO NOTHING`,
    )
    .run({
      company: t.company,
      description: t.description,
      norm: normalize(t.description),
      assignee: t.assignee ?? null,
      createdBy: t.createdBy ?? null,
      source: t.source ?? null,
      now,
    });
  if (info.changes === 0) return undefined; // deduped against an existing open task
  const row = getDb().prepare(`SELECT * FROM tasks WHERE id = ?`).get(info.lastInsertRowid) as Row;
  return toTask(row);
}

export interface ListTasksQuery {
  company: string;
  /** Omit for all statuses; usually 'open'. */
  status?: TaskStatus;
  /** Omit for everyone's; set to scope to one assignee ("what's on MY plate"). */
  assignee?: string;
  limit?: number;
}

/** Tasks for a workspace, newest first, optionally filtered by status / assignee. */
export function listTasks(q: ListTasksQuery): Task[] {
  const where = ['company = ?'];
  const args: unknown[] = [q.company];
  if (q.status) {
    where.push('status = ?');
    args.push(q.status);
  }
  if (q.assignee) {
    where.push('assignee = ?');
    args.push(q.assignee);
  }
  const rows = getDb()
    .prepare(`SELECT * FROM tasks WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`)
    .all(...args, q.limit ?? 50) as Row[];
  return rows.map(toTask);
}

/** All open tasks for a workspace (oldest first) — context for the reflect prompt's dedup. */
export function openTasks(company: string): Task[] {
  const rows = getDb()
    .prepare(`SELECT * FROM tasks WHERE company = ? AND status = 'open' ORDER BY created_at ASC`)
    .all(company) as Row[];
  return rows.map(toTask);
}

/** Mark a task done. Company-enforced so an id can't close another workspace's task. */
export function completeTask(company: string, id: number): boolean {
  return setStatus(company, id, 'done');
}

/** Drop a task (no longer relevant). Company-enforced. */
export function dropTask(company: string, id: number): boolean {
  return setStatus(company, id, 'dropped');
}

function setStatus(company: string, id: number, status: TaskStatus): boolean {
  const info = getDb()
    .prepare(`UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND company = ?`)
    .run(status, new Date().toISOString(), id, company);
  return info.changes > 0;
}
