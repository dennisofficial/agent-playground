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
  createdAt: string;
  updatedAt: string;
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
  /** Restrict to tickets this bot has a plan on (the per-employee view); omit for the whole board. */
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
