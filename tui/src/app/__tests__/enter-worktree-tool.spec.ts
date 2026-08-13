import { describe, expect, it } from 'bun:test';
import { EAtlasTool, EToolTier } from '../../domain/tool-surface.js';
import { EPhaseKind, EThreadRole } from '../../generated/prisma/enums.js';
import type { Job, Thread } from '../../generated/prisma/client.js';
import { atlasToolsFor } from '../tools/registry.js';
import type {
  AtlasTool,
  ToolActions,
  ToolContext,
  WorktreeActions,
} from '../tools/tool.js';

/**
 * `enter_worktree`'s place in the surface — door three, and the one that was missing.
 *
 * With only the two UI doors built, an agent asked for a worktree reached for `git worktree add`
 * through the shell: the directory appears, `Job.workspacePath` stays null, and every later turn
 * keeps running in the tree the worktree was supposed to keep it out of. This file is the assertion
 * that the door exists and that its edges are where they were argued to be.
 */

function context(args: { phase: EPhaseKind; role: EThreadRole }): ToolContext {
  return {
    job: { id: 'job-1', branch: null, workspacePath: null } as unknown as Job,
    thread: { id: 'thread-1', role: args.role } as unknown as Thread,
    phase: args.phase,
    cwd: '/repo',
    tier: EToolTier.thread,
  };
}

function actions(worktree?: WorktreeActions): ToolActions {
  return {
    advanceThread: async () => 'advanced',
    advancePhase: async () => 'proposed',
    openThread: async () => 'opened',
    completeThread: async () => 'completed',
    rotate: async () => 'rotated',
    ...(worktree ? { worktree } : {}),
  };
}

function enterTool(tools: readonly AtlasTool[]): AtlasTool | undefined {
  return tools.find((tool) => tool.name === EAtlasTool.enter_worktree);
}

function recordingWorktree() {
  const calls: ToolContext[] = [];
  const worktree: WorktreeActions = {
    take: async (args) => {
      calls.push(args.ctx);
      return 'worktree taken';
    },
  };
  return { worktree, calls };
}

const EVERY_PHASE = [
  EPhaseKind.generic,
  EPhaseKind.charting,
  EPhaseKind.design,
  EPhaseKind.planning,
  EPhaseKind.build,
  EPhaseKind.direct_build,
  EPhaseKind.master_review,
  EPhaseKind.post_build,
  EPhaseKind.ci,
];

describe('the enter_worktree surface', () => {
  /**
   * The deliberate contrast with `ship_pr`, which is gated hard to `ci`. Shipping only means
   * something at the end of a pipeline; taking a worktree is a precondition for writing at all, and
   * a job earns one LATE — at a moment no phase table can predict.
   */
  it('is offered in every phase, because any phase can turn out to need one', () => {
    for (const phase of EVERY_PHASE) {
      const tools = atlasToolsFor({
        ctx: context({ phase, role: EThreadRole.builder }),
        actions: actions(recordingWorktree().worktree),
      });
      expect(enterTool(tools)).toBeDefined();
    }
  });

  it('is absent from a teammate, which shares the directory of the thread that owns it', () => {
    const tools = atlasToolsFor({
      ctx: {
        ...context({ phase: EPhaseKind.build, role: EThreadRole.builder }),
        tier: EToolTier.teammate,
      },
      actions: actions(recordingWorktree().worktree),
    });
    // Relocating the tree would move the ground under the turn its owner is currently running in.
    expect(enterTool(tools)).toBeUndefined();
  });

  it('is absent when nothing is wired to take one, rather than present and failing', () => {
    const tools = atlasToolsFor({
      ctx: context({ phase: EPhaseKind.build, role: EThreadRole.builder }),
      actions: actions(),
    });
    expect(enterTool(tools)).toBeUndefined();
  });

  /**
   * No arguments at all. Every input this could take is derived from the job, and a parameter the
   * agent chooses is a parameter it can choose wrong — a path outside the repository, or a branch
   * somebody else is standing on.
   */
  it('takes no arguments, so there is nothing for the agent to get wrong', async () => {
    const { worktree, calls } = recordingWorktree();
    const ctx = context({ phase: EPhaseKind.build, role: EThreadRole.builder });
    const tool = enterTool(atlasToolsFor({ ctx, actions: actions(worktree) }));
    if (!tool) throw new Error('enter_worktree is not in the surface');

    expect(Object.keys(tool.shape)).toEqual([]);
    expect(await tool.handler({})).toBe('worktree taken');
    expect(calls).toEqual([ctx]);
  });

  /**
   * The description is the agent's only rail, and the one thing it must carry is that the move does
   * not apply to the turn making the call. An agent that reads "you have a worktree" and carries on
   * editing reproduces the original bug through the tool built to fix it.
   */
  it('warns in its own description that the current turn does not move', () => {
    const tool = enterTool(
      atlasToolsFor({
        ctx: context({ phase: EPhaseKind.build, role: EThreadRole.builder }),
        actions: actions(recordingWorktree().worktree),
      }),
    );
    expect(tool?.description).toContain('does not move the turn you are in');
  });
});
