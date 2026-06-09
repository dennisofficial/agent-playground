import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { botById, ROSTER } from '../employees/index.js';
import { type Job, listJobs } from '../jobs.js';
import { getIdentity } from '../memory/identity.js';
import { cancelJob } from '../worker.js';
import { getBoard } from './index.js';
import type { Ticket, TicketComment } from './types.js';

/**
 * The shared Jira-board chat tools. Authorization is enforced HERE (not in the adapter): the scrum master
 * sees and acts on every ticket; everyone else sees only tickets they have a plan on. Approval and
 * execution are NOT here — approval is a human-only command (`/approve-ticket`), and execution of an
 * approved plan is the autonomy seam in chat.ts (`execute_ticket`).
 *
 * The board-MANAGEMENT tools below (status/assign/edit/clear/move/comment) are SCRUM-MASTER ONLY, gated the
 * same way as `flag_scope` — a plain `isScrumMaster` check returning a refusal, never a per-bot tool list.
 * Two deliberate guardrails: (1) the scrum master cannot APPROVE a ticket — that stays a human-only action
 * (`/approve-ticket`) because approval also freezes each plan into its build contract; (2) blocking,
 * dropping, or clearing a ticket that has live workers CANCELS those jobs (like `flag_scope`), so the board
 * state and the actual running work never disagree.
 */

const isScrumMaster = (botId: string): boolean => !!botById(botId)?.scrumMaster;
const SCRUM_ONLY = 'Only the scrum master can manage the board that way.';

// The statuses this tool may SET directly. `approved` is deliberately excluded — approval is human-only and
// must freeze each plan into its build contract via board.approve(), never a raw status write. This is the
// single source of truth for both the zod enum and the runtime guard, so the two can never drift apart.
const SETTABLE_STATUSES = ['blocked', 'dropped', 'done'] as const;

const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const fmtTicket = (t: Ticket, note?: TicketComment): string => {
  const head = `- [${t.id}] (${t.status}) ${t.title}${t.assignee ? ` → @${t.assignee}` : ''}`;
  return note ? `${head}\n    📌 ${note.author}: ${truncate(note.body, 100)}` : head;
};

/** A ticket's still-running or parked execute jobs (the work actually in flight on it). */
function activeJobsForTicket(project: string, ticketId: string): Job[] {
  return listJobs().filter(
    (j) =>
      j.ticketId === ticketId &&
      j.project === project &&
      (j.status === 'running' || j.status === 'awaiting'),
  );
}

/** Abort a ticket's in-flight execute jobs, so a block/drop actually stops the work (not just the board
 * label). Returns the cancelled job ids. Mirrors `flag_scope`'s cancel-then-mark. */
function cancelActiveJobsForTicket(project: string, ticketId: string): string[] {
  const active = activeJobsForTicket(project, ticketId);
  for (const j of active) cancelJob(j.id);
  return active.map((j) => j.id);
}

export const add_backlog_tool = tool(
  async ({ title, description }, config) => {
    const id = getIdentity(config);
    const t = getBoard().createTicket({
      project: id.project,
      title,
      description: description ?? '',
      createdBy: id.selfAgent,
    });
    return `Added ${t.id} to the backlog: "${t.title}". It's a proposal until Dennis approves it at standup.`;
  },
  {
    name: 'add_backlog',
    description:
      "Add an idea to the team's backlog as a proposed ticket — something worth doing that you or the team spotted. It stays a proposal (no work happens) until Dennis reviews and approves it at standup. Use this to capture ideas so they aren't lost.",
    schema: z.object({
      title: z
        .string()
        .describe('A short, concrete title, e.g. "Add rate limiting to the upload API".'),
      description: z
        .string()
        .optional()
        .describe('A sentence or two of context: the problem, why it matters.'),
    }),
  },
);

export const list_tickets_tool = tool(
  async ({ status }, config) => {
    const id = getIdentity(config);
    const all = isScrumMaster(id.selfAgent);
    const board = getBoard();
    const tickets = board.listTickets({
      project: id.project,
      status: status ?? undefined,
      ownerBot: all ? undefined : id.selfAgent, // non-scrum-master: tickets you have a plan on OR are assigned
    });
    if (tickets.length === 0)
      return all ? 'No tickets on the board yet.' : 'You have no tickets assigned.';
    const lines = tickets.map((t) => {
      const cs = board.listComments(id.project, t.id);
      return fmtTicket(t, cs[cs.length - 1]); // show the latest pinned note, if any
    });
    return `${all ? 'Board' : 'Your tickets'}${status ? ` (${status})` : ''}:\n${lines.join('\n')}`;
  },
  {
    name: 'list_tickets',
    description:
      "The team's Jira board. As scrum master you see every ticket; otherwise you see the tickets you have a plan on. Optionally filter by status (e.g. 'backlog' to review proposals, 'approved' to see what's ready to build).",
    schema: z.object({
      status: z
        .enum(['backlog', 'approved', 'in_progress', 'done', 'blocked', 'dropped'])
        .optional()
        .describe('Filter to one status; omit for all.'),
    }),
  },
);

export const attach_plan_tool = tool(
  async ({ ticketId, plan }, config) => {
    const id = getIdentity(config);
    const board = getBoard();
    const ticket = board.getTicket(id.project, ticketId);
    if (!ticket) return `No ticket "${ticketId}" on the board.`;
    if (ticket.status !== 'backlog')
      return `${ticket.id} is ${ticket.status} — its plans are locked. Plans can only be set while a ticket is in the backlog (before approval).`;
    const saved = board.attachPlan(id.project, ticketId, id.selfAgent, plan);
    return saved
      ? `Attached your plan to ${ticket.id}. It'll be reviewed with the others at standup before approval.`
      : `Couldn't attach a plan to ${ticketId}.`;
  },
  {
    name: 'attach_plan',
    description:
      "Attach YOUR discipline's plan (markdown) to a backlog ticket — what you'd build for it. A ticket can carry several plans (backend, frontend, design); each owner attaches their own. Editable only until Dennis approves the ticket, at which point the plan is frozen as the contract you'll execute.",
    schema: z.object({
      ticketId: z.string().describe('The ticket id, e.g. "TKT-001".'),
      plan: z
        .string()
        .describe(
          'Your plan as markdown — ordered steps, files/areas touched, acceptance criteria.',
        ),
    }),
  },
);

// ── Scrum-master board management (gated; see the module header) ─────────────────────────────────────

export const update_ticket_status_tool = tool(
  async ({ ticketId, status, reason }, config) => {
    const id = getIdentity(config);
    if (!isScrumMaster(id.selfAgent)) return SCRUM_ONLY;
    const board = getBoard();
    const ticket = board.getTicket(id.project, ticketId);
    if (!ticket) return `No ticket "${ticketId}" on the board.`;

    // Defense-in-depth backstop for the human-approval invariant: even if the schema enum ever drifts, this
    // tool can only ever write a settable status — never 'approved' (which must go through board.approve()).
    if (!SETTABLE_STATUSES.includes(status)) return SCRUM_ONLY;
    // Allowed transitions: any → blocked, any → dropped, in_progress → done.
    if (status === 'done' && ticket.status !== 'in_progress')
      return `Only an in-progress ticket can be marked done — ${ticket.id} is ${ticket.status}.`;
    // 'done' means the work LANDED — don't let it be set while a build is still in flight (the ticket would
    // diverge from its running worker, and a later straggler could flip it back). The build closes the ticket
    // on its own when it finishes; to stop it early, block or drop instead.
    if (status === 'done') {
      const active = activeJobsForTicket(id.project, ticketId);
      if (active.length)
        return `${ticket.id} is still being built (${active
          .map((j) => j.id)
          .join(', ')}) — let the build finish (it closes the ticket itself) or block/drop it; don't mark it done while work is running.`;
    }
    if ((status === 'blocked' || status === 'dropped') && !reason?.trim())
      return `A reason is required to mark ${ticket.id} ${status}.`;
    if (ticket.status === status) return `${ticket.id} is already ${status}.`;

    board.setStatus(id.project, ticketId, status);
    // Blocking/dropping must also STOP any work in flight, or the worker keeps building (and may publish a
    // branch) while the board says otherwise.
    let cancelled: string[] = [];
    if (status === 'blocked' || status === 'dropped')
      cancelled = cancelActiveJobsForTicket(id.project, ticketId);
    const stopNote = cancelled.length ? ` Stopped ${cancelled.join(', ')}.` : '';
    const why = reason?.trim() ? ` Reason: ${reason.trim()}.` : '';
    return `Moved ${ticket.id} to ${status}.${why}${stopNote}`;
  },
  {
    name: 'update_ticket_status',
    description:
      "Scrum master only: move a ticket through its lifecycle. You can mark it blocked (paused) or dropped (abandoned) from any status, or done once it's in progress — blocking or dropping also stops any work running on it. You CANNOT approve a ticket: approval is Dennis's at standup. A reason is required to block or drop.",
    schema: z.object({
      ticketId: z.string().describe('The ticket id, e.g. "TKT-001".'),
      status: z
        .enum(SETTABLE_STATUSES)
        .describe(
          "The new status: 'blocked' (paused), 'dropped' (abandoned), or 'done' (only if in progress and not still building). Approval is Dennis's, not a status you can set.",
        ),
      reason: z
        .string()
        .optional()
        .describe('Why — REQUIRED when blocking or dropping; omit for done.'),
    }),
  },
);

export const assign_ticket_tool = tool(
  async ({ ticketId, owner }, config) => {
    const id = getIdentity(config);
    if (!isScrumMaster(id.selfAgent)) return SCRUM_ONLY;
    const targetId = owner.trim().toLowerCase();
    if (!botById(targetId))
      return `"${owner}" isn't a teammate. Assign to one of: ${ROSTER.map((b) => b.id).join(', ')}.`;
    const board = getBoard();
    const ticket = board.getTicket(id.project, ticketId);
    if (!ticket) return `No ticket "${ticketId}" on the board.`;
    board.assign(id.project, ticketId, targetId);
    return `Assigned ${ticket.id} to @${targetId}. They'll see it on their board — but building it still needs their own approved plan.`;
  },
  {
    name: 'assign_ticket',
    description:
      "Scrum master only: assign or reassign a ticket to a teammate by id (e.g. 'alex', 'riley'). The assignee gets visibility of the ticket on their board; it does NOT let them build without an approved plan. Use it to manage ownership explicitly instead of relying on who attached a plan.",
    schema: z.object({
      ticketId: z.string().describe('The ticket id, e.g. "TKT-001".'),
      owner: z.string().describe("The teammate's id to own it, e.g. 'alex'."),
    }),
  },
);

export const edit_ticket_tool = tool(
  async ({ ticketId, title, description }, config) => {
    const id = getIdentity(config);
    if (!isScrumMaster(id.selfAgent)) return SCRUM_ONLY;
    if (title === undefined && description === undefined)
      return 'Nothing to edit — pass a new title and/or description.';
    const board = getBoard();
    const ticket = board.getTicket(id.project, ticketId);
    if (!ticket) return `No ticket "${ticketId}" on the board.`;
    board.updateMeta(id.project, ticketId, { title, description });
    const changed = [title !== undefined ? 'title' : null, description !== undefined ? 'description' : null]
      .filter(Boolean)
      .join(' and ');
    return `Updated ${ticket.id}'s ${changed}.`;
  },
  {
    name: 'edit_ticket',
    description:
      "Scrum master only: edit a ticket's title and/or description. Unlike plans (frozen once a ticket is approved), the ticket's own metadata stays editable at any status. Pass only the fields you want to change.",
    schema: z.object({
      ticketId: z.string().describe('The ticket id, e.g. "TKT-001".'),
      title: z.string().optional().describe('A new title; omit to leave it.'),
      description: z.string().optional().describe('A new description; omit to leave it.'),
    }),
  },
);

export const clear_board_tool = tool(
  async ({ status }, config) => {
    const id = getIdentity(config);
    if (!isScrumMaster(id.selfAgent)) return SCRUM_ONLY;
    const board = getBoard();
    const all = board.listTickets({ project: id.project, status: status ?? undefined });
    // Always skip already-dropped (no-op). On a BARE wipe (no filter) also preserve completed history —
    // dropping `done` tickets is rarely intended; require an explicit status:'done' to clear those.
    const targets = all.filter(
      (t) => t.status !== 'dropped' && (status ? true : t.status !== 'done'),
    );
    if (targets.length === 0)
      return status ? `No ${status} tickets to clear.` : 'Nothing on the board to clear.';
    const cancelled: string[] = [];
    for (const t of targets) {
      board.setStatus(id.project, t.id, 'dropped');
      cancelled.push(...cancelActiveJobsForTicket(id.project, t.id));
    }
    const scope = status ? `${status} ticket(s)` : 'ticket(s)';
    const ids = targets.map((t) => t.id).join(', ');
    const stopNote = cancelled.length ? ` Stopped ${cancelled.length} running job(s).` : '';
    const kept = !status ? ' (completed tickets kept.)' : '';
    return `Dropped ${targets.length} ${scope}: ${ids}.${stopNote}${kept}`;
  },
  {
    name: 'clear_board',
    description:
      "Scrum master only: bulk-drop tickets for a board reset or end-of-sprint cleanup. Pass a status to clear just those (e.g. 'backlog' to clear all proposals); omit it to clear the whole active board. Dropping is recoverable (status becomes 'dropped', nothing is deleted) and stops any running work. A bare clear keeps already-completed (done) tickets — pass status:'done' to drop those too.",
    schema: z.object({
      status: z
        .enum(['backlog', 'approved', 'in_progress', 'done', 'blocked'])
        .optional()
        .describe('Clear only tickets in this status; omit to clear the whole active board.'),
    }),
  },
);

export const move_ticket_tool = tool(
  async ({ ticketId, beforeTicketId }, config) => {
    const id = getIdentity(config);
    if (!isScrumMaster(id.selfAgent)) return SCRUM_ONLY;
    const board = getBoard();
    const ticket = board.getTicket(id.project, ticketId);
    if (!ticket) return `No ticket "${ticketId}" on the board.`;
    if (beforeTicketId && beforeTicketId === ticketId) return "A ticket can't be moved before itself.";
    if (beforeTicketId && !board.getTicket(id.project, beforeTicketId))
      return `No ticket "${beforeTicketId}" to place it before.`;
    board.moveTicket(id.project, ticketId, beforeTicketId);
    return beforeTicketId
      ? `Moved ${ticket.id} up to just before ${beforeTicketId}.`
      : `Moved ${ticket.id} to the bottom of the board.`;
  },
  {
    name: 'move_ticket',
    description:
      'Scrum master only: reorder the board for priority sequencing (e.g. during standup). Places a ticket immediately before another; omit the target to send it to the bottom.',
    schema: z.object({
      ticketId: z.string().describe('The ticket id to move, e.g. "TKT-001".'),
      beforeTicketId: z
        .string()
        .optional()
        .describe('Place it immediately before this ticket id; omit to move it to the bottom.'),
    }),
  },
);

export const add_ticket_comment_tool = tool(
  async ({ ticketId, comment }, config) => {
    const id = getIdentity(config);
    if (!isScrumMaster(id.selfAgent)) return SCRUM_ONLY;
    if (!comment.trim()) return 'Nothing to pin — the note is empty.';
    const board = getBoard();
    const ticket = board.getTicket(id.project, ticketId);
    if (!ticket) return `No ticket "${ticketId}" on the board.`;
    board.addComment(id.project, ticketId, id.selfAgent, comment.trim());
    return `Pinned a note to ${ticket.id}.`;
  },
  {
    name: 'add_ticket_comment',
    description:
      'Scrum master only: pin a note to a ticket — context that isn\'t part of the plan or description (e.g. "blocked on an external dependency, reassess next sprint"). Notes show up under the ticket on the board. Append-only; pinning doesn\'t touch the plan or description.',
    schema: z.object({
      ticketId: z.string().describe('The ticket id, e.g. "TKT-001".'),
      comment: z.string().describe('The note to pin.'),
    }),
  },
);

export const boardTools = [
  add_backlog_tool,
  list_tickets_tool,
  attach_plan_tool,
  update_ticket_status_tool,
  assign_ticket_tool,
  edit_ticket_tool,
  clear_board_tool,
  move_ticket_tool,
  add_ticket_comment_tool,
];
