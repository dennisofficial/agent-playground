import { getDb } from './db.js';

/**
 * Per-employee REMINDERS — each teammate's private "plate" so a commitment made in passing ("got it,
 * I'll do that after I finish this") survives a long, rolling-summarized work session instead of getting
 * lost. Every reminder is OWNED by exactly one employee (`owner`); a teammate sees only their own, the
 * scrum master sees all (enforced in the tools layer). Sibling to `worklog`: that's "what got done", this
 * is "what's still on someone's plate". Distinct from the shared Jira board (`board/`): reminders are the
 * lightweight personal layer, tickets are the formal one. Scoped by `project`, plain SQL — no embeddings.
 * Open-dedup is per (project, owner, norm), enforced by a unique partial index in [db.ts](db.ts).
 */
export type TaskStatus = 'open' | 'done' | 'dropped';

export interface Task {
  id: number;
  project: string;
  description: string;
  /** Whose plate this is on (bot/human id) — always set. */
  owner: string;
  createdBy?: string;
  status: TaskStatus;
  source?: string;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: number;
  project: string;
  description: string;
  owner: string;
  created_by: string | null;
  status: TaskStatus;
  source: string | null;
  created_at: string;
  updated_at: string;
}

const toTask = (r: Row): Task => ({
  id: r.id,
  project: r.project,
  description: r.description,
  owner: r.owner,
  createdBy: r.created_by ?? undefined,
  status: r.status,
  source: r.source ?? undefined,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** The dedup key: lowercased, whitespace-collapsed. Matches the `norm` column the unique index covers. */
const normalize = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

export interface NewTask {
  project: string;
  description: string;
  /** Whose plate it lands on (bot/human id) — required: every reminder has an owner. */
  owner: string;
  createdBy?: string;
  source?: string;
}

/**
 * Add a reminder to someone's plate. A duplicate OPEN reminder on the SAME plate (project + owner +
 * normalized description) is a silent no-op via the unique partial index — `ON CONFLICT DO NOTHING` — so
 * two bots reflecting on the same handoff don't both insert it. Returns the new row, or undefined on dedup.
 */
export function addTask(t: NewTask): Task | undefined {
  const now = new Date().toISOString();
  const info = getDb()
    .prepare(
      `INSERT INTO tasks (project, description, norm, owner, created_by, status, source, created_at, updated_at)
       VALUES (@project, @description, @norm, @owner, @createdBy, 'open', @source, @now, @now)
       ON CONFLICT DO NOTHING`,
    )
    .run({
      project: t.project,
      description: t.description,
      norm: normalize(t.description),
      owner: t.owner,
      createdBy: t.createdBy ?? null,
      source: t.source ?? null,
      now,
    });
  if (info.changes === 0) return undefined; // deduped against an existing open reminder on this plate
  const row = getDb().prepare(`SELECT * FROM tasks WHERE id = ?`).get(info.lastInsertRowid) as Row;
  return toTask(row);
}

export interface ListTasksQuery {
  project: string;
  /** Omit for all statuses; usually 'open'. */
  status?: TaskStatus;
  /** Omit for everyone's (scrum-master view); set to scope to one plate ("what's on MY plate"). */
  owner?: string;
  limit?: number;
}

/** Reminders for a workspace, newest first, optionally filtered by status / owner. */
export function listTasks(q: ListTasksQuery): Task[] {
  const where = ['project = ?'];
  const args: unknown[] = [q.project];
  if (q.status) {
    where.push('status = ?');
    args.push(q.status);
  }
  if (q.owner) {
    where.push('owner = ?');
    args.push(q.owner);
  }
  const rows = getDb()
    .prepare(`SELECT * FROM tasks WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`)
    .all(...args, q.limit ?? 50) as Row[];
  return rows.map(toTask);
}

/** All open reminders for a workspace (oldest first) — the scrum-master / standup whole-board view. */
export function openTasks(project: string): Task[] {
  const rows = getDb()
    .prepare(`SELECT * FROM tasks WHERE project = ? AND status = 'open' ORDER BY created_at ASC`)
    .all(project) as Row[];
  return rows.map(toTask);
}

/**
 * The open reminders RELEVANT to one bot's turn: ones on its own plate plus ones it raised for others
 * (so the reconcile pass can dedup its own handoffs and the bot can complete what it owns). Oldest first.
 */
export function remindersForBot(project: string, botId: string): Task[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM tasks WHERE project = ? AND status = 'open' AND (owner = ? OR created_by = ?)
       ORDER BY created_at ASC`,
    )
    .all(project, botId, botId) as Row[];
  return rows.map(toTask);
}

/** A single reminder by id within a project (for authority checks), or undefined. */
export function getTask(project: string, id: number): Task | undefined {
  const row = getDb()
    .prepare(`SELECT * FROM tasks WHERE id = ? AND project = ?`)
    .get(id, project) as Row | undefined;
  return row ? toTask(row) : undefined;
}

/** Mark a task done. Project-enforced so an id can't close another workspace's task. */
export function completeTask(project: string, id: number): boolean {
  return setStatus(project, id, 'done');
}

/** Drop a task (no longer relevant). Project-enforced. */
export function dropTask(project: string, id: number): boolean {
  return setStatus(project, id, 'dropped');
}

function setStatus(project: string, id: number, status: TaskStatus): boolean {
  const info = getDb()
    .prepare(`UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND project = ?`)
    .run(status, new Date().toISOString(), id, project);
  return info.changes > 0;
}
