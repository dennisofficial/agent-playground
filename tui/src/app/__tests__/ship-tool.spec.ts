import { describe, expect, it } from 'bun:test';
import { EAtlasTool, EToolTier } from '../../domain/tool-surface.js';
import { EPhaseKind, EThreadRole } from '../../generated/prisma/enums.js';
import type { Job, Thread } from '../../generated/prisma/client.js';
import { atlasToolsFor } from '../tools/registry.js';
import type { AtlasTool, ShipActions, ToolActions, ToolContext } from '../tools/tool.js';

/**
 * `ship_pr`'s place in the surface: offered in `ci` and nowhere else, and absent rather than
 * present-and-throwing when nothing is wired to ship. The schema is the agent's only rail, so a tool
 * it can see is a tool it will try — a builder that could open a pull request mid-`build` would be
 * shipping past the review the pipeline exists to put in front of it.
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

function actions(shipping?: ShipActions): ToolActions {
  return {
    advanceThread: async () => 'advanced',
    advancePhase: async () => 'proposed',
    openThread: async () => 'opened',
    completeThread: async () => 'completed',
    rotate: async () => 'rotated',
    ...(shipping ? { shipping } : {}),
  };
}

function shipTool(tools: readonly AtlasTool[]): AtlasTool | undefined {
  return tools.find((tool) => tool.name === EAtlasTool.ship_pr);
}

function recordingShip() {
  const calls: { title: string; body: string }[] = [];
  const shipping: ShipActions = {
    ship: async (args) => {
      calls.push({ title: args.title, body: args.body });
      return 'shipped';
    },
  };
  return { shipping, calls };
}

describe('the ship_pr surface', () => {
  it('is offered in ci', () => {
    const tools = atlasToolsFor({
      ctx: context({ phase: EPhaseKind.ci, role: EThreadRole.ship_pr }),
      actions: actions(recordingShip().shipping),
    });
    expect(shipTool(tools)).toBeDefined();
  });

  it('is offered to the ci role too — a red build re-ships with the same call', () => {
    const tools = atlasToolsFor({
      ctx: context({ phase: EPhaseKind.ci, role: EThreadRole.ci }),
      actions: actions(recordingShip().shipping),
    });
    // Gated on the PHASE, not the role, which is what makes re-shipping need no second role.
    expect(shipTool(tools)).toBeDefined();
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
        actions: actions(recordingShip().shipping),
      });
      expect(shipTool(tools)).toBeUndefined();
    }
  });

  it('is absent from a teammate, which never acts outside this machine', () => {
    const tools = atlasToolsFor({
      ctx: { ...context({ phase: EPhaseKind.ci, role: EThreadRole.ci }), tier: EToolTier.teammate },
      actions: actions(recordingShip().shipping),
    });
    expect(shipTool(tools)).toBeUndefined();
  });

  it('is absent when nothing is wired to ship, rather than present and failing', () => {
    const tools = atlasToolsFor({
      ctx: context({ phase: EPhaseKind.ci, role: EThreadRole.ship_pr }),
      actions: actions(),
    });
    expect(shipTool(tools)).toBeUndefined();
  });

  it('hands the title and body straight through', async () => {
    const { shipping, calls } = recordingShip();
    const tools = atlasToolsFor({
      ctx: context({ phase: EPhaseKind.ci, role: EThreadRole.ship_pr }),
      actions: actions(shipping),
    });
    const tool = shipTool(tools);
    if (!tool) throw new Error('ship_pr is not in the surface');

    expect(await tool.handler({ title: 'Add avatar upload', body: 'Reads cold.' })).toBe('shipped');
    expect(calls).toEqual([{ title: 'Add avatar upload', body: 'Reads cold.' }]);
  });

  it('throws on a malformed call rather than resolving as if something happened', async () => {
    const { shipping, calls } = recordingShip();
    const tools = atlasToolsFor({
      ctx: context({ phase: EPhaseKind.ci, role: EThreadRole.ship_pr }),
      actions: actions(shipping),
    });
    const tool = shipTool(tools);
    if (!tool) throw new Error('ship_pr is not in the surface');

    // Unlike the task list, a ship that did not happen must not read as one that did — the throw
    // becomes an error result, which is the one shape a model does not narrate as success.
    await expect(tool.handler({ title: '' })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
