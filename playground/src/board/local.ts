import type { Database } from 'better-sqlite3';
import { getDb } from '../memory/db.js';
import type { Board, NewTicket, Ticket, TicketFilter, TicketPlan, TicketStatus } from './types.js';

/**
 * The internal SQLite board — the default `Board` until a real Jira adapter lands. Reuses the shared
 * `zero.db` connection but owns its own two tables (`tickets` + `ticket_plans`), created lazily on first
 * use, so the board stays self-contained and swappable. The display id is `TKT-<num>` derived from the
 * row's integer primary key — no separate id column to keep in sync.
 */

const now = () => new Date().toISOString();

const numToId = (num: number): string => `TKT-${String(num).padStart(3, '0')}`;
/** "TKT-001" → 1; tolerant of stray case/space. NaN when it isn't a ticket id. */
const idToNum = (id: string): number => {
  const m = /(\d+)\s*$/.exec(id.trim());
  return m ? Number(m[1]) : Number.NaN;
};

interface TicketRow {
  num: number;
  project: string;
  title: string;
  description: string;
  status: TicketStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
}
interface PlanRow {
  ticket_num: number;
  owner_bot: string;
  draft_md: string;
  approved_md: string;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

const toTicket = (r: TicketRow): Ticket => ({
  id: numToId(r.num),
  project: r.project,
  title: r.title,
  description: r.description,
  status: r.status,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const toPlan = (r: PlanRow): TicketPlan => ({
  ticketId: numToId(r.ticket_num),
  ownerBot: r.owner_bot,
  draftMd: r.draft_md,
  approvedMd: r.approved_md,
  approvedAt: r.approved_at ?? undefined,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

let ready = false;
function db(): Database {
  const d = getDb();
  if (!ready) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS tickets (
        num         INTEGER PRIMARY KEY,            -- display id = TKT-<num>
        project     TEXT NOT NULL,                  -- workspace isolation (a ticket belongs to one project)
        title       TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status      TEXT NOT NULL DEFAULT 'backlog',-- backlog | approved | in_progress | done | blocked | dropped
        created_by  TEXT NOT NULL,                  -- who raised it (bot/human id)
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tickets_lookup ON tickets(project, status);

      -- One plan per discipline per ticket. draft_md is editable while the ticket is in backlog; approval
      -- snapshots it into approved_md (the frozen contract an employee executes).
      CREATE TABLE IF NOT EXISTS ticket_plans (
        ticket_num  INTEGER NOT NULL,
        owner_bot   TEXT NOT NULL,                  -- discipline owner (alex/riley/maya)
        draft_md    TEXT NOT NULL DEFAULT '',
        approved_md TEXT NOT NULL DEFAULT '',       -- frozen at approval; '' until then
        approved_at TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        PRIMARY KEY (ticket_num, owner_bot)
      );
    `);
    ready = true;
  }
  return d;
}

/** A ticket row, scoped to its project so an id can't reach across workspaces. */
function ticketRow(project: string, id: string): TicketRow | undefined {
  const num = idToNum(id);
  if (!Number.isFinite(num)) return undefined;
  return db().prepare(`SELECT * FROM tickets WHERE num = ? AND project = ?`).get(num, project) as
    | TicketRow
    | undefined;
}

export const localBoard: Board = {
  name: 'local',

  createTicket(t: NewTicket): Ticket {
    const ts = now();
    const info = db()
      .prepare(
        `INSERT INTO tickets (project, title, description, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, 'backlog', ?, ?, ?)`,
      )
      .run(t.project, t.title, t.description ?? '', t.createdBy, ts, ts);
    const row = db()
      .prepare(`SELECT * FROM tickets WHERE num = ?`)
      .get(info.lastInsertRowid) as TicketRow;
    return toTicket(row);
  },

  getTicket(project: string, id: string): Ticket | undefined {
    const row = ticketRow(project, id);
    return row ? toTicket(row) : undefined;
  },

  listTickets(filter: TicketFilter): Ticket[] {
    const where = ['project = ?'];
    const args: unknown[] = [filter.project];
    if (filter.status) {
      where.push('status = ?');
      args.push(filter.status);
    }
    if (filter.ownerBot) {
      where.push('num IN (SELECT ticket_num FROM ticket_plans WHERE owner_bot = ?)');
      args.push(filter.ownerBot);
    }
    const rows = db()
      .prepare(`SELECT * FROM tickets WHERE ${where.join(' AND ')} ORDER BY num ASC`)
      .all(...args) as TicketRow[];
    return rows.map(toTicket);
  },

  setStatus(project: string, id: string, status: TicketStatus): boolean {
    const num = idToNum(id);
    if (!Number.isFinite(num)) return false;
    const info = db()
      .prepare(`UPDATE tickets SET status = ?, updated_at = ? WHERE num = ? AND project = ?`)
      .run(status, now(), num, project);
    return info.changes > 0;
  },

  attachPlan(
    project: string,
    ticketId: string,
    ownerBot: string,
    draftMd: string,
  ): TicketPlan | undefined {
    const ticket = ticketRow(project, ticketId);
    // Immutability guard: plans are editable ONLY while the ticket is an unapproved backlog idea.
    if (!ticket || ticket.status !== 'backlog') return undefined;
    const ts = now();
    db()
      .prepare(
        `INSERT INTO ticket_plans (ticket_num, owner_bot, draft_md, approved_md, created_at, updated_at)
         VALUES (?, ?, ?, '', ?, ?)
         ON CONFLICT(ticket_num, owner_bot) DO UPDATE SET draft_md = excluded.draft_md, updated_at = excluded.updated_at`,
      )
      .run(ticket.num, ownerBot, draftMd, ts, ts);
    return localBoard.getPlan(project, ticketId, ownerBot);
  },

  getPlan(project: string, ticketId: string, ownerBot: string): TicketPlan | undefined {
    const ticket = ticketRow(project, ticketId);
    if (!ticket) return undefined;
    const row = db()
      .prepare(`SELECT * FROM ticket_plans WHERE ticket_num = ? AND owner_bot = ?`)
      .get(ticket.num, ownerBot) as PlanRow | undefined;
    return row ? toPlan(row) : undefined;
  },

  listPlans(project: string, ticketId: string): TicketPlan[] {
    const ticket = ticketRow(project, ticketId);
    if (!ticket) return [];
    const rows = db()
      .prepare(`SELECT * FROM ticket_plans WHERE ticket_num = ? ORDER BY owner_bot ASC`)
      .all(ticket.num) as PlanRow[];
    return rows.map(toPlan);
  },

  approve(project: string, id: string): Ticket | undefined {
    const ticket = ticketRow(project, id);
    if (!ticket) return undefined;
    const ts = now();
    // Freeze each discipline's draft into the immutable approved snapshot, then flip the ticket.
    db()
      .prepare(
        `UPDATE ticket_plans SET approved_md = draft_md, approved_at = ?, updated_at = ? WHERE ticket_num = ?`,
      )
      .run(ts, ts, ticket.num);
    db()
      .prepare(`UPDATE tickets SET status = 'approved', updated_at = ? WHERE num = ?`)
      .run(ts, ticket.num);
    return localBoard.getTicket(project, id);
  },
};
