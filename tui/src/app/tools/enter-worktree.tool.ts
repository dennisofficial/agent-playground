import { EAtlasTool, EToolTier } from '../../domain/tool-surface.js';
import type { AtlasTool, ToolActions, ToolContext } from './tool.js';

const DESCRIPTION = `Move this job out of the shared project tree and into a git worktree of its own,
on its own branch.

Call this **before you start writing** when the work is more than a question — anything that will
leave commits behind. Dennis has an editor open on the project tree; a branch checked out there is a
branch yanked out from under him mid-thought, and a worktree is how Atlas never touches it.

One call does all of it: the branch is named after this job, the worktree is created under
\`.worktrees/\`, and Atlas records both so that every later turn, and \`ship_pr\`, use them.

**Safe to call again.** A job already standing in a worktree is told so and nothing is created.

Takes no arguments — the branch and the directory are derived from the job, so there is nothing to
choose and nothing to name. It does not adopt an existing branch: if this work belongs on a branch
somebody already made, say so instead of calling this, because that is Dennis's to point at.

**It does not move the turn you are in.** Read the reply before doing anything else — a working
directory cannot be changed underneath a running turn, so the move lands on your next one.`;

/**
 * `enter_worktree` — door three, and the reason the other two were not enough.
 *
 * Ungated on phase, deliberately, where `ship_pr` is gated hard to `ci`. Shipping is the end of a
 * pipeline and only means something at the end; taking a worktree is a *precondition* for writing at
 * all, and every phase from `generic` up can turn out to need one — the whole design is that a job
 * takes a worktree LATE, when the work earns it, which is a moment no phase table can predict.
 *
 * Threads only. A teammate is owned by a thread and shares its directory; letting one relocate the
 * tree its owner is working in would move the ground under a turn that is currently running in it.
 */
export function enterWorktreeTool(args: {
  ctx: ToolContext;
  actions: ToolActions;
}): AtlasTool | null {
  const { worktree } = args.actions;
  if (!worktree) return null;

  return {
    name: EAtlasTool.enter_worktree,
    description: DESCRIPTION,
    tiers: [EToolTier.thread],
    // No arguments at all. Every input this could take is derived from the job, and a parameter the
    // agent gets to choose would be a parameter it gets to choose WRONG — a path outside the repo, a
    // branch somebody else is on.
    shape: {},
    handler: async () => worktree.take({ ctx: args.ctx }),
  };
}
