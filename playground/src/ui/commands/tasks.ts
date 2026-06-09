import { DEFAULT_PROJECT } from '../../memory/identity.js';
import { listTasks } from '../../memory/tasks.js';
import type { Command } from './types.js';

/**
 * `/tasks` — dump every employee's open reminders (what the reflect pass has captured) into the transcript.
 * A CLI-local view, not a chat message, so the TUI renders it itself. Exact match; trailing text falls through.
 */
export const tasksCommand: Command = {
  name: 'tasks',
  summary: '/tasks — list open reminders',
  run(text, ctx) {
    if (text !== '/tasks') return false;
    const tasks = listTasks({ project: DEFAULT_PROJECT, status: 'open' });
    ctx.note(
      tasks.length
        ? `Open reminders (${tasks.length}):\n` +
            tasks.map((t) => `  #${t.id}  [${t.owner}]  ${t.description}`).join('\n')
        : 'No open reminders yet.',
    );
    return true;
  },
};
