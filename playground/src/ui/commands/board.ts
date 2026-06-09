import { getBoard } from '../../board/index.js';
import { conductor } from '../../conductor.js';
import { DEFAULT_PROJECT } from '../../memory/identity.js';
import type { Command } from './types.js';

/** `/tickets` — dump the Jira board into the transcript (a CLI-local view, not a chat message). */
export const ticketsCommand: Command = {
  name: 'tickets',
  summary: '/tickets — show the board',
  run(text, ctx) {
    if (text !== '/tickets') return false;
    const board = getBoard();
    const tickets = board.listTickets({ project: DEFAULT_PROJECT });
    ctx.note(
      tickets.length
        ? `Board (${tickets.length}):\n` +
            tickets
              .map((t) => {
                const assignee = t.assignee ? `  → @${t.assignee}` : '';
                const notes = board.listComments(DEFAULT_PROJECT, t.id).length;
                const noteTag = notes ? `  📌${notes}` : '';
                return `  ${t.id}  (${t.status})  ${t.title}${assignee}${noteTag}`;
              })
              .join('\n')
        : 'No tickets on the board yet.',
    );
    return true;
  },
};

/** `/standup` — post a synthetic prompt as you so Sam leads the backlog review. No note (it goes to chat). */
export const standupCommand: Command = {
  name: 'standup',
  summary: '/standup — kick off a standup (Sam leads)',
  run(text) {
    if (text !== '/standup') return false;
    conductor.submitUser(
      "Standup time. Sam, lead us through it — walk me through the backlog and let's decide what to work on. Everyone, share what's on your plate and what you got done.",
    );
    return true;
  },
};
