import { visibleTools } from '../../domain/tool-surface.js';
import { advancePhaseTool } from './advance-phase.tool.js';
import { advanceThreadTool } from './advance-thread.tool.js';
import { completeThreadTool } from './complete-thread.tool.js';
import { enterWorktreeTool } from './enter-worktree.tool.js';
import { openThreadTool } from './open-thread.tool.js';
import { recordPrTool } from './record-pr.tool.js';
import { rotateTool } from './rotate.tool.js';
import { serviceListTool } from './service-list.tool.js';
import { serviceStartTool } from './service-start.tool.js';
import { serviceStopTool } from './service-stop.tool.js';
import { taskCreateTool } from './task-create.tool.js';
import { taskListTool } from './task-list.tool.js';
import { taskUpdateTool } from './task-update.tool.js';
import type { AtlasTool, ToolActions, ToolContext } from './tool.js';

/**
 * Every Atlas tool, in one list.
 *
 * **This is where a new tool is registered** — one entry here and one file beside this one. A
 * builder returns `null` when the audience has nothing legal to call, which is how a tool becomes
 * ABSENT rather than present-and-throwing: the schema is the agent's only rail, and a tool it can
 * see is a tool it will try.
 *
 * Read is deliberately not here and never will be. Reads go through the `atlas` CLI over the
 * normalised store, which is what holds this surface at a dozen tools instead of legacy's
 * sixty-three — and which both engines already know how to drive, since both have a shell.
 */
const BUILDERS: readonly ((args: {
  ctx: ToolContext;
  actions: ToolActions;
}) => AtlasTool | null)[] = [
  advanceThreadTool,
  advancePhaseTool,
  openThreadTool,
  completeThreadTool,
  taskCreateTool,
  taskUpdateTool,
  taskListTool,
  rotateTool,
  recordPrTool,
  serviceStartTool,
  serviceStopTool,
  serviceListTool,
  enterWorktreeTool,
];

/**
 * The tools a session may see, decided in exactly one place.
 *
 * Two moments, one rule: a builder declines when it cannot construct a legal schema for this
 * audience, and `visibleTools` filters what remains by tier. Nothing downstream re-checks — the
 * transport renders what it is given, and a tool that got here is a tool that may be called.
 */
export function atlasToolsFor(args: {
  ctx: ToolContext;
  actions: ToolActions;
}): readonly AtlasTool[] {
  const built = BUILDERS.map((build) => build(args)).filter(
    (tool): tool is AtlasTool => tool !== null,
  );
  return visibleTools({
    tools: built,
    tier: args.ctx.tier,
    role: args.ctx.thread.role,
    phase: args.ctx.phase,
  });
}
