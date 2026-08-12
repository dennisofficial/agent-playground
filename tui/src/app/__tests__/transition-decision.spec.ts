import { afterAll, describe, expect, it } from 'bun:test';
import { EHarnessVariant, promptPayload, renderPrompt } from '../../domain/message.js';
import { EPhaseKind, EThreadRole, ETransitionStatus } from '../../generated/prisma/enums.js';
import { JOB, cleanupWorlds, world } from './advance-phase.fixture.js';

/**
 * And answering it does all of it at once — or records that it was refused, which is the half that
 * has no other home.
 */

afterAll(cleanupWorlds);

describe('confirming it', () => {
  it('appends the phase, opens its first thread, seeds it, and closes the proposer', async () => {
    const { service, ctx, phases, rows, turns, closed, outcomes } = world();
    await service.advancePhase({
      ctx,
      kind: EPhaseKind.build,
      reason: 'the plan is written',
      handoff: 'Slices are in specs/. I rejected a shared cache — invalidation is per-job.',
      attach: ['specs/02-slice.md'],
    });

    const { phase, thread } = await service.confirmTransition({
      transitionId: rows[0]?.id ?? '',
      cwd: '/repo',
    });

    expect(phases).toHaveLength(2);
    expect(phase.kind).toBe(EPhaseKind.build);
    expect(phase.ordinal).toBe(1);
    // The phase's own first role, and it lands IN the phase the confirmation just created.
    expect(thread.role).toBe(EThreadRole.builder);
    expect(thread.phaseId).toBe(phase.id);
    // Phases never return: the thread that proposed is closed, not suspended.
    expect(closed).toEqual([ctx.thread.id]);
    // And it says HOW it closed. `phase_advanced` is Atlas's to stamp — it is true because the phase
    // moved, not because the agent claimed it — and the hand-off is that thread's own last word,
    // kept here because the copy it delivered lives in a thread in the NEXT phase.
    expect(outcomes).toEqual([
      {
        threadId: ctx.thread.id,
        condition: 'phase_advanced',
        resolution:
          'Slices are in specs/. I rejected a shared cache — invalidation is per-job.',
      },
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.thread.id).toBe(thread.id);
    expect(turns[0]?.harnessVariant).toBe(EHarnessVariant.handoff);
    expect(turns[0]?.prompt).toContain('rejected a shared cache');
    expect(rows[0]?.status).toBe(ETransitionStatus.confirmed);
    expect(rows[0]?.createdPhaseId).toBe(phase.id);
  });

  it('inlines the DESTINATION phase’s floor — the successor gets what it is entering, not what was left', async () => {
    const { service, ctx, rows, turns } = world();
    await service.advancePhase({
      ctx,
      kind: EPhaseKind.build,
      reason: 'the plan is written',
      handoff: 'go',
      attach: [],
    });

    await service.confirmTransition({ transitionId: rows[0]?.id ?? '', cwd: '/repo' });

    // Asked of what the model RECEIVES: the bodies ride the message's attachment manifest now and
    // are composed onto the wire at send, so the prose alone answers a different question.
    const turn = turns[0];
    const prompt = renderPrompt(
      promptPayload({
        text: turn?.prompt ?? '',
        harnessVariant: turn?.harnessVariant,
        attachments: turn?.attachments,
      }),
    );
    // A builder needs `specs/`, however it got there — planning's own floor would have handed it
    // the map and left it without the plan.
    expect(prompt).toContain('the plan, shared by every builder');
    expect(prompt).not.toContain('the map, charting’s own');
    expect(prompt).not.toContain('slice two, one thread’s');
  });

  it('refuses to decide the same proposal twice', async () => {
    const { service, ctx, rows } = world();
    await service.advancePhase({
      ctx,
      kind: EPhaseKind.build,
      reason: 'done',
      handoff: 'go',
      attach: [],
    });
    const id = rows[0]?.id ?? '';
    await service.confirmTransition({ transitionId: id, cwd: '/repo' });

    // Several TUIs on one database is normal, so the second terminal is looking at an answered row.
    await expect(service.confirmTransition({ transitionId: id, cwd: '/repo' })).rejects.toThrow(
      'already confirmed',
    );
  });
});

describe('declining it', () => {
  it('keeps the row with its reason, and leaves the job exactly where it was', async () => {
    const { service, ctx, rows, phases, turns, closed } = world();
    await service.advancePhase({
      ctx,
      kind: EPhaseKind.build,
      reason: 'done',
      handoff: 'go',
      attach: [],
    });

    await service.declineTransition({
      transitionId: rows[0]?.id ?? '',
      reason: 'the plan misses the migration',
    });

    expect(rows[0]?.status).toBe(ETransitionStatus.declined);
    expect(rows[0]?.declineReason).toBe('the plan misses the migration');
    expect(phases).toHaveLength(1);
    expect(turns).toHaveLength(0);
    // The proposing thread stays open: Dennis says why in the composer he is already looking at.
    expect(closed).toEqual([]);
    expect(await service.pendingTransitions(JOB.id)).toHaveLength(0);
  });
});

describe('an exit that carries no decision', () => {
  it('transitions inside the call, and still leaves the row behind', async () => {
    const { service, ctx, phases, rows, turns, closed } = world({
      phase: EPhaseKind.build,
      role: EThreadRole.builder,
    });

    const reply = await service.advancePhase({
      ctx,
      kind: EPhaseKind.master_review,
      reason: 'every slice is built and its review is applied',
      handoff: 'Built slices 1-3.',
      attach: [],
    });

    expect(phases).toHaveLength(2);
    expect(phases[1]?.kind).toBe(EPhaseKind.master_review);
    expect(closed).toEqual([ctx.thread.id]);
    expect(turns).toHaveLength(1);
    // Written first either way, so an automatic exit leaves the audit a confirmed one leaves.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe(ETransitionStatus.confirmed);
    expect(reply).toContain('Confirmed');
    expect(reply).toContain('This thread is closed');
  });
});

