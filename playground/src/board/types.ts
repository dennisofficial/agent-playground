/**
 * The shared TICKET BOARD — the team's "Jira", as an interface so a real Jira adapter can drop in later
 * (mirrors the `engines/` registry pattern). A ticket is a unit of work with a lifecycle; it carries 0..N
 * per-discipline PLANS as markdown (backend/frontend/design), produced during standup planning. A ticket
 * is approved ONCE at standup; that approval freezes each plan into an immutable `approvedMd` snapshot,
 * which is the contract an employee later executes — no second per-build human gate.
 *
 * Distinct from per-employee reminders (`memory/tasks.ts`): reminders are the lightweight personal plate;
 * tickets are the formal, shared, approved-work layer.
 *
 * The Board interface is AUTH-AGNOSTIC pure CRUD. Authorization (scrum master sees/acts on all; everyone
 * else only their own tickets; only a human approves) is enforced in the tools/conductor layer — the same
 * place `cancel_job` ownership is checked — never inside the adapter.
 */

export type TicketStatus =
  | 'backlog' // an idea/proposal, not yet approved; plans are still mutable drafts
  | 'approved' // approved at standup; plan snapshots are frozen, ready to execute
  | 'in_progress' // an employee is executing an approved plan right now
  | 'done' // the work landed
  | 'blocked' // paused — e.g. the scrum master flagged it out of scope
  | 'dropped'; // abandoned

export interface Ticket {
  /** Display id, e.g. "TKT-001". */
  id: string;
  project: string;
  title: string;
  description: string;
  status: TicketStatus;
  /** Who raised it (bot/human id). */
  createdBy: string;
  /**
   * Explicit owner (a teammate's bot id), set by the scrum master via `assign`. Empty/undefined = no
   * explicit assignee (ownership is implied by whoever attached a plan). Assignment ALSO grants that bot
   * visibility of the ticket in its `list_tickets` view — but it does NOT authorize a build: executing a
   * ticket still requires that bot's own APPROVED plan (the write-safety invariant stays intact).
   */
  assignee?: string;
  createdAt: string;
  updatedAt: string;
}

/** A pinned note on a ticket — context that isn't part of the plan or description (e.g. "blocked on an
 * external dependency, reassess next sprint"). Append-only; written by the scrum master. */
export interface TicketComment {
  id: number;
  ticketId: string;
  /** Who pinned the note (bot/human id). */
  author: string;
  body: string;
  createdAt: string;
}

export interface TicketPlan {
  ticketId: string;
  /** The discipline owner this plan is for (e.g. "alex" = backend). */
  ownerBot: string;
  /** The working plan — editable ONLY while the ticket is in `backlog`. */
  draftMd: string;
  /** The frozen contract, snapshotted from `draftMd` at approval. Empty until the ticket is approved. */
  approvedMd: string;
  approvedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewTicket {
  project: string;
  title: string;
  description?: string;
  /** Who raised it (bot/human id). */
  createdBy: string;
}

export interface TicketFilter {
  project: string;
  status?: TicketStatus;
  /** Restrict to tickets VISIBLE to this bot — ones it has a plan on OR is assigned (the per-employee
   * view); omit for the whole board (the scrum-master view). */
  ownerBot?: string;
}

/**
 * The swappable board backend. `local.ts` is the SQLite implementation; a future `jira.ts` implements the
 * same surface against real Jira. Methods are pure data ops — no permission checks live here.
 */
export interface Board {
  readonly name: string;

  createTicket(t: NewTicket): Ticket;
  getTicket(project: string, id: string): Ticket | undefined;
  listTickets(filter: TicketFilter): Ticket[];
  /** Set a ticket's status directly (lifecycle transitions other than approval). Returns false if absent. */
  setStatus(project: string, id: string, status: TicketStatus): boolean;

  /** Edit a ticket's metadata (title and/or description). Unlike plans (frozen at approval), metadata stays
   * editable by the scrum master at any status. Returns the updated ticket, or undefined if absent. */
  updateMeta(project: string, id: string, patch: { title?: string; description?: string }): Ticket | undefined;
  /** Set a ticket's explicit assignee (a teammate's bot id). Returns the updated ticket, or undefined if
   * absent. The CALLER enforces authority and that the id is a real teammate — the adapter does not. */
  assign(project: string, id: string, assignee: string): Ticket | undefined;
  /** Reorder a ticket on the board: place it immediately BEFORE `beforeId`, or at the end when `beforeId`
   * is omitted or not found. Returns false if the moved ticket is absent. */
  moveTicket(project: string, id: string, beforeId?: string): boolean;

  /** Pin a note to a ticket. Returns the stored comment, or undefined if the ticket is absent. */
  addComment(project: string, id: string, author: string, body: string): TicketComment | undefined;
  /** All notes pinned to a ticket, oldest first. */
  listComments(project: string, id: string): TicketComment[];

  /**
   * Upsert this bot's DRAFT plan onto a ticket. Returns undefined (a no-op) when the ticket is absent OR
   * not in `backlog` — the immutability guard: once approved, plans are frozen and cannot be re-attached.
   */
  attachPlan(
    project: string,
    ticketId: string,
    ownerBot: string,
    draftMd: string,
  ): TicketPlan | undefined;
  /** This bot's plan for a ticket (draft + frozen snapshot), or undefined. */
  getPlan(project: string, ticketId: string, ownerBot: string): TicketPlan | undefined;
  /** All discipline plans attached to a ticket. */
  listPlans(project: string, ticketId: string): TicketPlan[];

  /**
   * Approve a ticket: snapshot every plan's `draftMd → approvedMd` (the immutable contract) and move the
   * ticket to `approved`. Idempotent-ish; returns the ticket, or undefined if it's absent. The CALLER must
   * have already checked human authority — the adapter does not.
   */
  approve(project: string, id: string): Ticket | undefined;
}
