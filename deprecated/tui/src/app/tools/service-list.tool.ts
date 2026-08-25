import { EAtlasTool, EToolTier } from '../../domain/tool-surface.js';
import type { AtlasTool, ToolActions, ToolContext } from './tool.js';

const DESCRIPTION = `What this job has running: id, description, status, uptime and log path.

Not convenience. Services belong to the JOB, so a thread opened after a seam inherits services it
never started and this is its only way to learn their ids — worth calling once when you arrive
somewhere with a hand-off, the same way \`task_list\` is.`;

/**
 * `service_list` — no arguments, like `task_list`, and for the same reason: the job is the scope and
 * the handler already has it.
 */
export function serviceListTool(args: {
  ctx: ToolContext;
  actions: ToolActions;
}): AtlasTool | null {
  const { services } = args.actions;
  if (!services) return null;

  return {
    name: EAtlasTool.service_list,
    tiers: [EToolTier.thread],
    description: DESCRIPTION,
    // Nothing to validate is nothing to reject. The empty case answers in prose rather than with an
    // empty list — an agent that reads `[]` learns nothing about where services come from.
    shape: {},
    handler: async () => services.list({ jobId: args.ctx.job.id }),
  };
}
