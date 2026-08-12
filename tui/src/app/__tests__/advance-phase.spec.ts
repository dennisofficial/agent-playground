import { afterAll, describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { EPhaseKind, EThreadRole, EThreadStatus } from '../../generated/prisma/enums.js';
import type { Thread } from '../../generated/prisma/client.js';
import { advancePhaseTool } from '../tools/advance-phase.tool.js';
import { atlasToolsFor } from '../tools/registry.js';
import { JOB, cleanupWorlds, world } from './advance-phase.fixture.js';

/**
 * Calling `advance_phase` moves NOTHING. The phase log and the thread list are exactly as they
 * were, and the only new thing in the world is a row somebody has to answer.
 */

afterAll(cleanupWorlds);

describe('advance_phase raises a proposal', () => {
  it('moves NOTHING — no phase, no thread, no turn', async () => {
    const { service, ctx, phases, threads, turns, closed } = world();

    const reply = await service.advancePhase({
      ctx,
      kind: EPhaseKind.build,
      reason: 'the plan is written and reviewed',
      handoff: 'Slices are in specs/.',
      attach: [],
    });

    expect(phases).toHaveLength(1);
    expect(threads).toHaveLength(1);
    expect(turns).toHaveLength(0);
    expect(closed).toEqual([]);
    expect(reply).toContain('NOTHING has moved');
  });

  it('writes what the overlay will show, and what the successor will read', async () => {
    const { service, ctx, rows } = world();

    await service.advancePhase({
      ctx,
      kind: EPhaseKind.build,
      reason: 'the plan is written and reviewed',
      handoff: 'Slices are in specs/. I rejected a shared cache.',
      attach: ['specs/02-slice.md'],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.to).toBe(EPhaseKind.build);
    expect(rows[0]?.reason).toContain('written and reviewed');
    expect(rows[0]?.handoff).toContain('rejected a shared cache');
    expect(rows[0]?.attach).toEqual(['specs/02-slice.md']);
    expect(rows[0]?.raisedByThreadId).toBe(ctx.thread.id);
    expect(rows[0]?.fromPhaseId).toBe(ctx.thread.phaseId);
    expect(await service.pendingTransitions(JOB.id)).toHaveLength(1);
  });

  it('tells the agent what it attached and what Atlas could not resolve', async () => {
    const { service, ctx } = world();

    const reply = await service.advancePhase({
      ctx,
      kind: EPhaseKind.build,
      reason: 'done',
      handoff: 'done',
      attach: ['generated/handoff.md'],
    });

    expect(reply).toContain('ignored');
    expect(reply).toContain('generated/handoff.md');
  });

  it('throws while a sibling is still open, and writes no row', async () => {
    const { service, ctx, threads, rows } = world();
    threads.push({
      id: 'thread-sibling',
      phaseId: 'phase-1',
      role: EThreadRole.charting,
      status: EThreadStatus.active,
    } as unknown as Thread);

    await expect(
      service.advancePhase({
        ctx,
        kind: EPhaseKind.build,
        reason: 'done',
        handoff: 'done',
        attach: [],
      }),
    ).rejects.toThrow('still open');
    expect(rows).toEqual([]);
  });

  it('refuses an edge the phase does not propose', async () => {
    const { service, ctx, rows } = world();

    await expect(
      service.advancePhase({
        ctx,
        kind: EPhaseKind.ci,
        reason: 'done',
        handoff: 'done',
        attach: [],
      }),
    ).rejects.toThrow('does not propose');
    expect(rows).toEqual([]);
  });
});

describe('the advance_phase tool', () => {
  it('offers exactly the edges the phase proposes — the schema is the rail', () => {
    const { service, ctx } = world();
    const tool = advancePhaseTool({ ctx, actions: service });

    expect(tool).not.toBeNull();
    const schema = z.object(tool?.shape ?? {});
    const call = { reason: 'done', handoff: 'go', attach: [] };
    expect(schema.safeParse({ ...call, kind: EPhaseKind.build }).success).toBe(true);
    // `planning → ci` is nonsense, and it is unemittable rather than rejected after the fact.
    expect(schema.safeParse({ ...call, kind: EPhaseKind.ci }).success).toBe(false);
    // `attach` is required — an empty array is a statement, an omission is not.
    expect(
      schema.safeParse({ kind: EPhaseKind.build, reason: 'done', handoff: 'go' }).success,
    ).toBe(false);
  });

  it('is ABSENT in a phase that proposes nothing, rather than present and refusing', () => {
    const { service, ctx } = world({ phase: EPhaseKind.ci, role: EThreadRole.ci });

    // `ci.next` is empty — nothing to propose. It never means nothing is legal: re-entry after a
    // red build is Dennis starting a phase, and this graph never railed him.
    expect(advancePhaseTool({ ctx, actions: service })).toBeNull();
    expect(atlasToolsFor({ ctx, actions: service }).map((tool) => tool.name)).not.toContain(
      'advance_phase',
    );
  });

  it('tells a phase that waits and a phase that does not two different things', () => {
    const asks = world();
    const auto = world({ phase: EPhaseKind.build, role: EThreadRole.builder });

    const asking = advancePhaseTool({ ctx: asks.ctx, actions: asks.service })?.description ?? '';
    const going = advancePhaseTool({ ctx: auto.ctx, actions: auto.service })?.description ?? '';

    expect(asking).toContain('Nothing transitions when you call this');
    // Promising a builder that Dennis will confirm would be a lie it gets no turn to discover.
    expect(going).toContain('takes effect immediately');
    expect(going).not.toContain('Nothing transitions when you call this');
  });

  it('routes a parsed call straight through to the seam', async () => {
    const { service, ctx, rows } = world();
    const tool = advancePhaseTool({ ctx, actions: service });

    const reply = await tool?.handler({
      kind: EPhaseKind.build,
      reason: 'the plan is written',
      handoff: 'go',
      attach: [],
    });

    expect(reply).toContain('Raised');
    expect(rows).toHaveLength(1);
  });
});
