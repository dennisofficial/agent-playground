import { describe, expect, it } from 'vitest';
import {
  buildPipelineSimulator,
  makeDriver,
  type Script,
} from './pipeline-simulator.test-util';

/**
 * Engine-stubbed pipeline SIMULATION catalog. Unlike pipeline-runner.section-driver.spec.ts (which
 * fakes the session runner), every scenario here drives the REAL PipelineRunnerService +
 * SessionRunnerService + InMemorySessionRegistry + ReviewPipelineService end-to-end, stubbing ONLY the
 * AI engine. So these exercise the SEAM: the detached turn, the onUpdate→onSessionUpdate relay,
 * fire-and-forget error handling, orphaned-session cleanup, and the real PR-gate review/ship path.
 */

const drive = (script: Script = {}, opts = {}) =>
  makeDriver(buildPipelineSimulator(script, opts));

describe('pipeline simulator — flagship happy paths', () => {
  it('2-section feature flows plan→gate→build(+review)→next→ship through the real seam', async () => {
    const d = drive({
      byKey: {
        // backend plans 2 ungrouped phases; frontend uses the default (1 phase).
        'plan:phase_backend': { kind: 'plan', phases: [{ id: 1 }, { id: 2 }] },
      },
    });

    await d.dispatchFeature([
      { name: 'backend', role: 'phase_backend' },
      { name: 'frontend', role: 'phase_frontend' },
    ]);
    // start() opened the backend plan session, which reported → paused at the gate.
    expect((await d.run())?.status).toBe('paused');
    expect((await d.run())?.planningSubstep).toBe('gate');

    await d.approve(); // backend builds 2 phases (+review each), section done, frontend plan → gate
    expect((await d.run())?.planningSubstep).toBe('gate');

    await d.approve(); // frontend builds 1 phase (+review), no sections left → ship

    expect((await d.run())?.status).toBe('done');
    expect(d.shipCalls()).toBe(1);
    expect(d.prReadyEvents()).toHaveLength(1);
    expect(d.turns()).toEqual([
      { mode: 'plan', role: 'phase_backend' },
      { mode: 'execute', role: 'phase_backend' },
      { mode: 'investigate', role: 'phase_backend' },
      { mode: 'execute', role: 'phase_backend' },
      { mode: 'investigate', role: 'phase_backend' },
      { mode: 'plan', role: 'phase_frontend' },
      { mode: 'execute', role: 'phase_frontend' },
      { mode: 'investigate', role: 'phase_frontend' },
    ]);
    expect(d.sim.errors).toEqual([]);
  });

  it('bugfix runs a single execute session straight to the PR and ships', async () => {
    const d = drive();
    await d.dispatchBugfix('phase_backend');
    expect((await d.run())?.status).toBe('done');
    expect(d.turns()).toEqual([{ mode: 'execute', role: 'phase_backend' }]);
    expect(d.shipCalls()).toBe(1);
    expect(d.sim.errors).toEqual([]);
  });

  it('a plan with no `phases` block falls back to a single build phase', async () => {
    const d = drive({
      byKey: { 'plan:phase_backend': { kind: 'plan', noPhasesBlock: true } },
    });
    await d.dispatchFeature([{ name: 'backend', role: 'phase_backend' }]);
    await d.approve();
    expect((await d.run())?.status).toBe('done');
    expect(d.turns().map((t) => t.mode)).toEqual(['plan', 'execute', 'investigate']);
  });
});

describe('pipeline simulator — gate decisions', () => {
  it('changes-requested re-plans and the feedback reaches the REAL plan prompt, then ships', async () => {
    const d = drive();
    await d.dispatchFeature([{ name: 'backend', role: 'phase_backend' }]);
    await d.requestChanges('Use Postgres, not Redis');
    // Back to drafting → a fresh plan turn ran, then re-gated.
    expect((await d.run())?.planningSubstep).toBe('gate');
    const planTurns = d.sim.engine.turns.filter((t) => t.mode === 'plan');
    expect(planTurns).toHaveLength(2);
    expect(planTurns[1].task).toContain('Use Postgres, not Redis'); // real sectionPlanPrompt threading

    await d.approve();
    expect((await d.run())?.status).toBe('done');
    expect(d.shipCalls()).toBe(1);
  });

  it('changes-requested then denied releases the run as failed (a clean release, not a crash)', async () => {
    const d = drive();
    await d.dispatchFeature([{ name: 'backend', role: 'phase_backend' }]);
    await d.requestChanges();
    await d.deny();
    expect((await d.run())?.status).toBe('failed');
    // Deny is Dennis releasing the ticket — NOT a failRun, so no run-failed crash event.
    expect(d.events().some((e) => e.kind === 'run-failed')).toBe(false);
    expect(d.shipCalls()).toBe(0);
  });

  it('a plan turn that ASKS relays questions (no card) and answer_section resumes the same session', async () => {
    const d = drive({
      byKey: {
        'plan:phase_backend': [
          { kind: 'questions' },
          { kind: 'plan', phases: [{ id: 1 }] },
        ],
      },
    });
    await d.dispatchFeature([{ name: 'backend', role: 'phase_backend' }]);
    // Questions → relayed, NOT proposed; run still drafting.
    expect(d.sim.proposalCalls).toHaveLength(0);
    expect(d.events().some((e) => e.kind === 'section-questions')).toBe(true);
    expect((await d.run())?.planningSubstep).toBe('drafting');

    await d.answerQuestions('Use Postgres.');
    // The reply ran a second plan turn on the SAME session → finished plan → gate.
    expect((await d.run())?.planningSubstep).toBe('gate');
    expect(d.sim.proposalCalls).toHaveLength(1);
    expect(d.sim.engine.turns.filter((t) => t.mode === 'plan')).toHaveLength(2);
  });
});

describe('pipeline simulator — review-blocker decisions', () => {
  it('a group-review blocker pauses at a stage decision (no ship); fix-up re-enters the gate and ships', async () => {
    const d = drive({
      byKey: {
        // first group review blocks; build execute, then the fix-up execute (both phase_backend).
        'investigate:phase_backend': { kind: 'review', blocker: true, summary: 'seam defect' },
        'execute:phase_backend': [{ kind: 'execute' }, { kind: 'execute' }],
      },
    });
    await d.dispatchFeature([{ name: 'backend', role: 'phase_backend' }]);
    await d.approve();
    expect((await d.run())?.status).toBe('paused');
    expect((await d.run())?.planningSubstep).toBe('stage_decision');
    const decisions = d.events().filter((e) => e.kind === 'stage-decision');
    expect(decisions).toHaveLength(1);
    expect(d.shipCalls()).toBe(0);

    // The blocker verdict would re-fire on a re-review, so disarm it before the fix-up path.
    d.arm({ byKey: { 'execute:phase_backend': { kind: 'execute' } } });
    const r = await d.dispatchFixup('patch the seam');
    expect(r.ok).toBe(true);
    expect((await d.run())?.status).toBe('done');
    expect(d.shipCalls()).toBe(1);
  });

  it('reopen_section drops the section back to planning carrying the defect, then re-gates', async () => {
    const d = drive({
      byKey: {
        'investigate:phase_backend': { kind: 'review', blocker: true, summary: 'bad seam' },
      },
    });
    await d.dispatchFeature([{ name: 'backend', role: 'phase_backend' }]);
    await d.approve();
    expect((await d.run())?.planningSubstep).toBe('stage_decision');

    const r = await d.reopenSection('backend', 'the plan missed auth');
    expect(r.ok).toBe(true);
    const sec = (await d.sections()).find((s) => s.name === 'backend')!;
    expect(sec.status).toBe('planning');
    // A fresh plan turn carried the defect through the REAL prompt.
    const lastPlan = [...d.sim.engine.turns].reverse().find((t) => t.mode === 'plan');
    expect(lastPlan?.task).toContain('the plan missed auth');
  });
});

describe('pipeline simulator — seam-only failures (FSM spec cannot reach these)', () => {
  it('a stage turn that THROWS fails the run, reopens the ticket, and reclaims the failed session', async () => {
    const d = drive({ byKey: { 'execute:phase_backend': { kind: 'throw' } } });
    await d.dispatchFeature([{ name: 'backend', role: 'phase_backend' }]);
    await d.approve(); // build execute throws mid-cascade
    expect((await d.run())?.status).toBe('failed');
    expect(d.events().some((e) => e.kind === 'run-failed')).toBe(true);
    expect((await d.sim.board.get('T1', 7))?.status).toBe('open');
    // No stage session is left dangling.
    const live = (await d.sim.sessions.list()).filter((s) => s.status !== 'closed');
    expect(live).toHaveLength(0);
  });

  it('every superseded stage session is reclaimed by run end (no orphans block cleanup)', async () => {
    const d = drive({
      byKey: { 'plan:phase_backend': { kind: 'plan', phases: [{ id: 1 }, { id: 2 }] } },
    });
    await d.dispatchFeature([{ name: 'backend', role: 'phase_backend' }]);
    await d.approve();
    expect((await d.run())?.status).toBe('done');
    const all = await d.sim.sessions.list();
    expect(all.length).toBeGreaterThan(1);
    expect(all.every((s) => s.status === 'closed')).toBe(true);
  });

  it('a full-impl review of CHANGES at the PR gate re-pauses (no ship); a passing re-review then ships', async () => {
    const d = drive(
      {
        byKey: {
          // full-impl review (team-lead role) flips changes→pass across its two runs; group/lens stay clean.
          'investigate:atlas': [
            { kind: 'review', fullImpl: 'changes' },
            { kind: 'review', fullImpl: 'pass' },
          ],
        },
      },
      { reviewFiles: ['a.ts'] }, // make the real full-impl review turn actually run
    );
    await d.dispatchFeature([{ name: 'backend', role: 'phase_backend' }]);
    await d.approve();
    // PR gate ran the real full-impl review → CHANGES → paused, no ship.
    expect((await d.run())?.status).toBe('paused');
    expect((await d.run())?.planningSubstep).toBe('stage_decision');
    expect(d.shipCalls()).toBe(0);
    expect(d.sim.engine.turns.some((t) => t.mode === 'investigate' && t.role === 'atlas')).toBe(true);

    await d.dispatchFixup(); // fixup → re-review now PASS → ship
    expect((await d.run())?.status).toBe('done');
    expect(d.shipCalls()).toBe(1);
  });

  it('a review-turn throw degrades to a clean PASS (review never fails the run) and ships', async () => {
    const d = drive(
      { byKey: { 'investigate:atlas': { kind: 'throw' } } },
      { reviewFiles: ['a.ts'] },
    );
    await d.dispatchFeature([{ name: 'backend', role: 'phase_backend' }]);
    await d.approve();
    // The full-impl review turn threw, but reviewFullImplementation's .catch degrades to pass → ship.
    expect((await d.run())?.status).toBe('done');
    expect(d.shipCalls()).toBe(1);
    expect(d.events().some((e) => e.kind === 'run-failed')).toBe(false);
  });

  it('a fix-up turn that itself throws fails the run (not a silent re-pause)', async () => {
    const d = drive({
      byKey: {
        'investigate:phase_backend': { kind: 'review', blocker: true, summary: 'defect' },
        'execute:phase_backend': [{ kind: 'execute' }, { kind: 'throw' }], // build ok, fix-up throws
      },
    });
    await d.dispatchFeature([{ name: 'backend', role: 'phase_backend' }]);
    await d.approve();
    expect((await d.run())?.planningSubstep).toBe('stage_decision');

    await d.dispatchFixup();
    expect((await d.run())?.status).toBe('failed');
    expect(d.events().some((e) => e.kind === 'run-failed')).toBe(true);
  });

  it('a shipTask failure fails the run loudly — no false "shipped", no pr-ready', async () => {
    const d = drive({}, { shipFails: true });
    await d.dispatchFeature([{ name: 'backend', role: 'phase_backend' }]);
    await d.approve();
    expect((await d.run())?.status).toBe('failed');
    expect(d.prReadyEvents()).toHaveLength(0);
    expect(d.shipCalls()).toBe(0); // openPr threw before markReady
    expect(d.events().some((e) => e.kind === 'run-failed')).toBe(true);
  });

  it('round-trips the plan→build contract: group folding + handoff threading through real prompts', async () => {
    const d = drive({
      byKey: {
        'plan:phase_backend': {
          kind: 'plan',
          phases: [
            { id: 1, group: 1 },
            { id: 2, group: 1 },
            { id: 3, group: 2 },
          ],
        },
        'execute:phase_backend': [
          { kind: 'execute', handoff: 'HANDOFF-XYZ exposed POST /api/x' },
          { kind: 'execute' },
        ],
      },
    });
    await d.dispatchFeature([{ name: 'backend', role: 'phase_backend' }]);
    await d.approve();
    expect((await d.run())?.status).toBe('done');

    // 3 phases folded into 2 coding sessions (group 1 = phases 1+2, group 2 = phase 3).
    const sec = (await d.sections()).find((s) => s.name === 'backend')!;
    const coding = await d.sim.codingStore.listForSection(sec.id as string);
    expect(coding).toHaveLength(2);

    // Group 2's execute prompt inherited group 1's handoff verbatim (real parseHandoff → priorHandoffs).
    const execTurns = d.sim.engine.turns.filter((t) => t.mode === 'execute');
    expect(execTurns).toHaveLength(2);
    expect(execTurns[1].task).toContain('HANDOFF-XYZ exposed POST /api/x');
  });
});

describe('pipeline simulator — boot recovery through the real registry', () => {
  it('a section approved during downtime is replayed on resume → builds and ships', async () => {
    const d = drive();
    await d.dispatchFeature([{ name: 'backend', role: 'phase_backend' }]);
    expect((await d.run())?.status).toBe('paused'); // at the gate, board not yet approved here

    // Approval landed during downtime: the board shows 'approved' but the event won't re-fire.
    await d.sim.board.update('T1', 7, { status: 'approved' });
    await d.sim.pipeline.resumePipelines();
    await d.sim.settle();

    expect((await d.run())?.status).toBe('done');
    expect(d.shipCalls()).toBe(1);
  });
});
