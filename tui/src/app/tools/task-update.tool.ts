import { z } from 'zod';
import { EAtlasTool, EToolTier } from '../../domain/tool-surface.js';
import { ETaskStatus } from '../../generated/prisma/enums.js';
import type { AtlasTool, ToolActions, ToolContext } from './tool.js';

const DESCRIPTION = `Move one task on your list, by its number.

Mark a task \`in_progress\` when you start it and \`completed\` when it is done — a list that is only
updated at the end of a turn is a list Dennis cannot use while you work.

It returns the whole list, so you never need \`task_list\` straight after. An unknown number is
answered, not refused: nothing here can fail your turn.`;

const TASK = `The task's number, as shown in the list — the \`3\` in \`#3 [pending] …\`.

Numbers are permanent. They are never reused, and deleting a task does not renumber the ones after
it, so a number you wrote down earlier still points at the same task.`;

const STATUS = `Where the task now stands.

\`deleted\` retires a task you are no longer going to do: it stops rendering, but it stays in the
record — a plan that silently loses entries reads as a plan that was never made.`;

const TEXT = `The task's text, if you are correcting it. Omit it to change only the status.`;

/**
 * `task_update` — one task, by number.
 *
 * Deliberately one task per call rather than a batch of edits: a batch has partial-failure semantics
 * to explain and the reply is the whole list either way, so the second call costs a line of output
 * and buys an unambiguous answer to "did that land".
 */
export function taskUpdateTool(args: {
  ctx: ToolContext;
  actions: ToolActions;
}): AtlasTool | null {
  const { tasks } = args.actions;
  if (!tasks) return null;

  const shape = {
    task: z.number().int().positive().describe(TASK),
    status: z
      .enum([
        ETaskStatus.pending,
        ETaskStatus.in_progress,
        ETaskStatus.completed,
        ETaskStatus.deleted,
      ])
      .describe(STATUS),
    text: z.string().min(1).optional().describe(TEXT),
  };

  return {
    name: EAtlasTool.task_update,
    description: DESCRIPTION,
    tiers: [EToolTier.thread],
    shape,
    handler: async (raw) => {
      // Never throws — see `task_create`. A bad shape and a bad number get the same courtesy: a
      // sentence saying what happened and what to call.
      const parsed = z.object(shape).safeParse(raw);
      if (!parsed.success) {
        return 'task_update takes `task` (a number from the list) and `status` (pending, in_progress, completed or deleted). Nothing changed — call task_list.';
      }
      return tasks.update({
        threadId: args.ctx.thread.id,
        ordinal: parsed.data.task,
        status: parsed.data.status,
        ...(parsed.data.text === undefined ? {} : { text: parsed.data.text }),
      });
    },
  };
}
