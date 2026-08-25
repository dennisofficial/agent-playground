import { EAtlasTool, EToolTier } from '../../domain/tool-surface.js';
import type { AtlasTool, ToolActions, ToolContext } from './tool.js';

const DESCRIPTION = `Show your task list.

Worth calling when you have inherited a thread — the list outlives the session that wrote it, so a
hand-off may hand you tasks you did not create. \`task_create\` and \`task_update\` already return
the list, so calling this straight after one of them tells you nothing new.`;

/**
 * `task_list` — the whole list, rendered.
 *
 * No arguments, and no `task_get` beside it: a task is one line, so a getter could only return what
 * the list already shows. The one read in a surface where every other read is the `atlas` CLI, and
 * it earns that by being the state the agent itself is authoring.
 */
export function taskListTool(args: {
  ctx: ToolContext;
  actions: ToolActions;
}): AtlasTool | null {
  const { tasks } = args.actions;
  if (!tasks) return null;

  return {
    name: EAtlasTool.task_list,
    description: DESCRIPTION,
    tiers: [EToolTier.thread],
    // No arguments at all. Nothing to validate is nothing to reject — this handler cannot fail on
    // its input, and the service below it answers rather than throws.
    shape: {},
    handler: async () => tasks.list({ threadId: args.ctx.thread.id }),
  };
}
