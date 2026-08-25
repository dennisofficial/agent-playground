import { describe, expect, it } from 'bun:test';
import { EAtlasTool, EToolTier } from '../../domain/tool-surface.js';
import { EPhaseKind, EThreadRole } from '../../generated/prisma/enums.js';
import type { Job, Thread } from '../../generated/prisma/client.js';
import { atlasToolsFor } from '../tools/registry.js';
import type {
  AtlasTool,
  PullRequestActions,
  ToolActions,
  ToolContext,
} from '../tools/tool.js';

/**
 * `record_pr`'s place in the surface: offered in `ci` and nowhere else, and absent rather than
 * present-and-throwing when nothing is wired to record.
 *
 * The gate is surface economy, NOT a safeguard — this tool opens nothing, and its predecessor's
 * "a builder must not ship past review" argument died with the shipping. `Bash` is in every thread's
 * native kit, so nothing here has ever been able to stop a determined `gh pr create`.
 */

function context(args: { phase: EPhaseKind; role: EThreadRole }): ToolContext {
  return {
    job: { id: 'job-1', branch: 'atlas/x' } as unknown as Job,
    thread: { id: 'thread-1', role: args.role } as unknown as Thread,
    phase: args.phase,
    cwd: '/tmp/atlas',
    tier: EToolTier.thread,
  };
}

function actions(pullRequest?: PullRequestActions): ToolActions {
  return {
    advanceThread: async () => 'advanced',
    advancePhase: async () => 'proposed',
    openThread: async () => 'opened',
    completeThread: async () => 'completed',
    rotate: async () => 'rotated',
    ...(pullRequest ? { pullRequest } : {}),
  };
}

function recordTool(tools: readonly AtlasTool[]): AtlasTool | undefined {
  return tools.find((tool) => tool.name === EAtlasTool.record_pr);
}

function recordingPullRequest() {
  const calls: string[] = [];
  const pullRequest: PullRequestActions = {
    record: async (args) => {
      calls.push(args.url);
      return 'recorded';
    },
  };
  return { pullRequest, calls };
}

describe('the record_pr surface', () => {
  it('is offered in ci', () => {
    const tools = atlasToolsFor({
      ctx: context({ phase: EPhaseKind.ci, role: EThreadRole.ship_pr }),
      actions: actions(recordingPullRequest().pullRequest),
    });
    expect(recordTool(tools)).toBeDefined();
  });

  it('is offered to the ci role too — a red build re-ships with the same call', () => {
    const tools = atlasToolsFor({
      ctx: context({ phase: EPhaseKind.ci, role: EThreadRole.ci }),
      actions: actions(recordingPullRequest().pullRequest),
    });
    // Gated on the PHASE, not the role, which is what makes re-shipping need no second role.
    expect(recordTool(tools)).toBeDefined();
  });

  it('is absent everywhere else', () => {
    for (const phase of [
      EPhaseKind.generic,
      EPhaseKind.charting,
      EPhaseKind.planning,
      EPhaseKind.build,
      EPhaseKind.direct_build,
      EPhaseKind.master_review,
      EPhaseKind.post_build,
    ]) {
      const tools = atlasToolsFor({
        ctx: context({ phase, role: EThreadRole.builder }),
        actions: actions(recordingPullRequest().pullRequest),
      });
      expect(recordTool(tools)).toBeUndefined();
    }
  });

  it('is absent from a teammate, which has no standing to say what the job shipped', () => {
    const tools = atlasToolsFor({
      ctx: { ...context({ phase: EPhaseKind.ci, role: EThreadRole.ci }), tier: EToolTier.teammate },
      actions: actions(recordingPullRequest().pullRequest),
    });
    expect(recordTool(tools)).toBeUndefined();
  });

  it('is absent when nothing is wired to record, rather than present and failing', () => {
    const tools = atlasToolsFor({
      ctx: context({ phase: EPhaseKind.ci, role: EThreadRole.ship_pr }),
      actions: actions(),
    });
    expect(recordTool(tools)).toBeUndefined();
  });

  it('hands the url straight through', async () => {
    const { pullRequest, calls } = recordingPullRequest();
    const tools = atlasToolsFor({
      ctx: context({ phase: EPhaseKind.ci, role: EThreadRole.ship_pr }),
      actions: actions(pullRequest),
    });
    const tool = recordTool(tools);
    if (!tool) throw new Error('record_pr is not in the surface');

    const url = 'https://github.com/dennis/atlas/pull/42';
    expect(await tool.handler({ url })).toBe('recorded');
    expect(calls).toEqual([url]);
  });

  it('describes no title or body — the pull request is the agent\'s to write and to open', () => {
    const tools = atlasToolsFor({
      ctx: context({ phase: EPhaseKind.ci, role: EThreadRole.ship_pr }),
      actions: actions(recordingPullRequest().pullRequest),
    });
    const tool = recordTool(tools);
    if (!tool) throw new Error('record_pr is not in the surface');

    // The whole point of the change: Atlas takes a URL for something that already exists, and has no
    // argument through which it could be asked to create one.
    expect(Object.keys(tool.shape)).toEqual(['url']);
  });

  it('throws on a malformed call rather than resolving as if something happened', async () => {
    const { pullRequest, calls } = recordingPullRequest();
    const tools = atlasToolsFor({
      ctx: context({ phase: EPhaseKind.ci, role: EThreadRole.ship_pr }),
      actions: actions(pullRequest),
    });
    const tool = recordTool(tools);
    if (!tool) throw new Error('record_pr is not in the surface');

    // Unlike the task list, a record that did not happen must not read as one that did — the throw
    // becomes an error result, which is the one shape a model does not narrate as success.
    await expect(tool.handler({ url: '' })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
