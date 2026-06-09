import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { botById } from '../employees/index.js';
import { getIdentity } from '../memory/identity.js';
import { getBoard } from './index.js';
import type { Ticket } from './types.js';

/**
 * The shared Jira-board chat tools. Authorization is enforced HERE (not in the adapter): the scrum master
 * sees and acts on every ticket; everyone else sees only tickets they have a plan on. Approval and
 * execution are NOT here — approval is a human-only command (`/approve-ticket`), and execution of an
 * approved plan is the autonomy seam in chat.ts (`execute_ticket`).
 */

const isScrumMaster = (botId: string): boolean => !!botById(botId)?.scrumMaster;

const fmtTicket = (t: Ticket): string => `- [${t.id}] (${t.status}) ${t.title}`;

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
    const tickets = getBoard().listTickets({
      project: id.project,
      status: status ?? undefined,
      ownerBot: all ? undefined : id.selfAgent, // non-scrum-master: only tickets you have a plan on
    });
    if (tickets.length === 0)
      return all ? 'No tickets on the board yet.' : 'You have no tickets assigned.';
    return `${all ? 'Board' : 'Your tickets'}${status ? ` (${status})` : ''}:\n${tickets
      .map(fmtTicket)
      .join('\n')}`;
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

export const boardTools = [add_backlog_tool, list_tickets_tool, attach_plan_tool];
