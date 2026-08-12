import { z } from 'zod';
import { EAtlasTool, EToolTier } from '../../domain/tool-surface.js';
import type { AtlasTool, ToolActions, ToolContext } from './tool.js';

const DESCRIPTION = `Write your plan down where Dennis can see it.

This is Atlas's task list and it is the ONLY one — the native todo tool is not available in this
harness. The list hangs off this thread, so it survives a session rotation: your successor inherits
these tasks and their numbers.

Call it once with the whole plan rather than a task at a time. Tasks are appended and keep their
numbers forever; \`task_update\` moves them.`;

const TASKS = `The steps of your plan, in order, one line each.

Written for a reader glancing at a panel above a composer — a short imperative phrase, not a
paragraph and not a filename. Ordinary work does not need a plan at all; reach for this when there
are enough moving parts that Dennis would otherwise have to ask what you are doing.`;

/**
 * `task_create` — the plan becomes visible.
 *
 * Nothing reads these rows back into a decision, which is what lets this tool be so plain: no
 * dependency edges, no ids to allocate, no failure the agent has to handle. It appends lines and
 * shows you the list.
 */
export function taskCreateTool(args: {
  ctx: ToolContext;
  actions: ToolActions;
}): AtlasTool | null {
  const { tasks } = args.actions;
  if (!tasks) return null;

  const shape = {
    tasks: z.array(z.string().min(1)).min(1).describe(TASKS),
  };

  return {
    name: EAtlasTool.task_create,
    description: DESCRIPTION,
    // Threads only. A teammate's progress shows as live activity in the thread that owns it — a
    // second checklist appearing beside its parent's would be two plans for one piece of work.
    tiers: [EToolTier.thread],
    shape,
    handler: async (raw) => {
      // `safeParse`, not `parse`. This tool must not throw for any input: a malformed call is worth
      // one sentence back, never a failed turn over a checklist.
      const parsed = z.object(shape).safeParse(raw);
      if (!parsed.success) {
        return 'task_create takes `tasks`: an array of one-line strings. Nothing was created.';
      }
      return tasks.create({
        threadId: args.ctx.thread.id,
        texts: parsed.data.tasks,
      });
    },
  };
}
