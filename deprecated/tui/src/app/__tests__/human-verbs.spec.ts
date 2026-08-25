import { afterAll, describe, expect, it } from 'bun:test';
import { EHarnessVariant } from '../../domain/message.js';
import {
  EPhaseKind,
  EThreadCondition,
  EThreadRole,
  EThreadStatus,
  ETransitionStatus,
} from '../../generated/prisma/enums.js';
import { cleanupWorlds, world } from './advance-phase.fixture.js';

afterAll(cleanupWorlds);

/**
 * The moves Dennis makes himself.
 *
 * The hole they close: every other creation mechanism is a TOOL, called from inside a turn, so a job
 * with nothing open has nobody home to propose and is structurally unenterable. These tests are
 * mostly about that — the last thread closing, and the job still working afterwards.
 */

describe('start a phase', () => {
  it('reaches a phase the current one would never propose', async () => {
    const w = world({ phase: EPhaseKind.ci, role: EThreadRole.ship_pr });
    // `ci.next` is empty: a menu built from the graph would strand this job with no legal move.
    const { phase, thread } = await w.humanVerbs.startPhase({
      jobId: 'job-1',
      kind: EPhaseKind.direct_build,
      cwd: '/repo',
    });

    expect(phase.kind).toBe(EPhaseKind.direct_build);
    expect(phase.ordinal).toBe(1);
    // The phase's own first role, the same one a confirmation opens with.
    expect(thread.role).toBe(EThreadRole.builder);
    expect(thread.phaseId).toBe(phase.id);
  });

  it('seeds the new thread on the phase’s own words, with no hand-off', async () => {
    const w = world({ phase: EPhaseKind.ci, role: EThreadRole.ship_pr });
    await w.humanVerbs.startPhase({
      jobId: 'job-1',
      kind: EPhaseKind.planning,
      cwd: '/repo',
    });

    const turn = w.turns.at(-1);
    // `seed`, not `handoff`: nobody handed over, so a borrowed attribution would be a lie about who
    // wrote the opening words.
    expect(turn?.harnessVariant).toBe(EHarnessVariant.seed);
    expect(turn?.prompt).toBe('Here is where you are.');
  });

  it('writes no transition row — there was no ask', async () => {
    const w = world({ phase: EPhaseKind.ci, role: EThreadRole.ship_pr });
    await w.humanVerbs.startPhase({ jobId: 'job-1', kind: EPhaseKind.ci, cwd: '/repo' });
    // A phase with no confirmed transition naming it IS, readably, one the human started. Recording
    // an ask that never happened under a source that cannot name him would be worse than silence.
    expect(w.rows).toHaveLength(0);
  });

  it('never silently closes a thread that is still working', async () => {
    const w = world({ phase: EPhaseKind.direct_build, role: EThreadRole.builder });
    await w.humanVerbs.startPhase({
      jobId: 'job-1',
      kind: EPhaseKind.post_build,
      cwd: '/repo',
    });
    // The harness must not kill a working agent — the same rule the agent's own advance states. The
    // builder keeps its session; Dennis closes it himself if he meant to.
    expect(w.closed).toEqual([]);
    expect(w.threads[0]?.status).toBe(EThreadStatus.active);
  });

  // The one confirmation implementation, proved by running both doors into the same fakes.
  it('writes what a confirmed proposal writes, minus the row', async () => {
    const byHand = world({ phase: EPhaseKind.planning });
    await byHand.humanVerbs.startPhase({
      jobId: 'job-1',
      kind: EPhaseKind.build,
      cwd: '/repo',
    });

    const byAgent = world({ phase: EPhaseKind.planning });
    await byAgent.service.advancePhase({
      ctx: byAgent.ctx,
      kind: EPhaseKind.build,
      reason: 'the plan is written',
      handoff: 'three slices',
      attach: [],
    });
    const raised = byAgent.rows[0];
    if (!raised) throw new Error('nothing was raised');
    await byAgent.service.confirmTransition({ transitionId: raised.id, cwd: '/repo' });

    expect(byHand.phases.map((p) => [p.kind, p.ordinal])).toEqual(
      byAgent.phases.map((p) => [p.kind, p.ordinal]),
    );
    expect(byHand.threads.at(-1)?.role).toBe(byAgent.threads.at(-1)?.role as EThreadRole);
    // The difference, and the only one: a proposal has a row to mark decided.
    expect(byAgent.rows[0]?.status).toBe(ETransitionStatus.confirmed);
    expect(byHand.rows).toHaveLength(0);
  });
});

describe('open a thread in the current phase', () => {
  it('offers the phase table’s roles and opens one', async () => {
    const w = world({ phase: EPhaseKind.ci, role: EThreadRole.ship_pr });
    const thread = await w.humanVerbs.openThread({
      jobId: 'job-1',
      role: EThreadRole.ci,
      cwd: '/repo',
    });

    expect(thread.role).toBe(EThreadRole.ci);
    // The CURRENT phase, joined rather than created: opening a thread never moves a job.
    expect(thread.phaseId).toBe('phase-1');
    expect(w.phases).toHaveLength(1);
    // And it takes the cursor, as every other thread-opening path does.
    expect(w.cursor.at(-1)).toBe(thread.id);
  });

  it('has nobody waiting on it', async () => {
    const w = world({ phase: EPhaseKind.planning });
    const thread = await w.humanVerbs.openThread({
      jobId: 'job-1',
      role: EThreadRole.research,
      cwd: '/repo',
    });
    // No `openedByThreadId`: a human-opened thread reports to no one, so when it closes it hands the
    // cursor on by the sibling rule rather than firing a report into an opener that does not exist.
    expect(thread.openedByThreadId).toBeNull();
  });

  /**
   * The bug this closes: pressing `n` in a charting phase was answered by an agent that had read
   * `map.md`, listed the frontier and proposed a ticket — all before Dennis had typed anything.
   * The phase's opening words orient a thread nobody is there to brief, and here somebody is.
   */
  it('fires NOTHING — it opens blank, on whatever he types', async () => {
    const w = world({ phase: EPhaseKind.charting, role: EThreadRole.charting });
    await w.humanVerbs.openThread({
      jobId: 'job-1',
      role: EThreadRole.task,
      cwd: '/repo',
    });

    expect(w.turns).toEqual([]);
  });

  // The contrast, and the reason this is a property of the VERB rather than of the role: a phase
  // started by hand still opens on the phase's own words, because its first thread genuinely has
  // nothing else to go on.
  it('leaves start-a-phase seeding, which is the case an opening is for', async () => {
    const w = world({ phase: EPhaseKind.charting, role: EThreadRole.charting });
    await w.humanVerbs.startPhase({
      jobId: 'job-1',
      kind: EPhaseKind.planning,
      cwd: '/repo',
    });

    expect(w.turns.at(-1)?.harnessVariant).toBe(EHarnessVariant.seed);
  });

  /**
   * `generic` in a phase whose table does not list it. The role exists so a question that is not
   * this job's work has somewhere honest to go — before it, the menu forced `task` or `builder`
   * onto it and the thread list then read as though the job had grown a piece of work.
   */
  it('opens the human’s side channel in a phase that hosts no generic role', async () => {
    const w = world({ phase: EPhaseKind.direct_build, role: EThreadRole.builder });
    const thread = await w.humanVerbs.openThread({
      jobId: 'job-1',
      role: EThreadRole.generic,
      cwd: '/repo',
    });

    expect(thread.role).toBe(EThreadRole.generic);
    expect(thread.phaseId).toBe('phase-1');
    expect(w.turns).toEqual([]);
  });

  it('refuses a role neither the phase nor the side channel offers', async () => {
    const w = world({ phase: EPhaseKind.ci, role: EThreadRole.ship_pr });
    // Unreachable through the menu, which is built from the same list — this is the belt to its
    // braces, for a page holding a phase the job has since left.
    await expect(
      w.humanVerbs.openThread({ jobId: 'job-1', role: EThreadRole.planner, cwd: '/repo' }),
    ).rejects.toThrow(/does not host/);
  });

  it('leaves a job with nothing running re-enterable', async () => {
    const w = world({ phase: EPhaseKind.ci, role: EThreadRole.ship_pr });
    await w.humanVerbs.closeThread({ jobId: 'job-1', threadId: 'thread-1' });
    expect(w.threads.every((t) => t.status === EThreadStatus.closed)).toBe(true);

    // The state this whole ticket exists for: nothing is open, and both creation verbs still work.
    const thread = await w.humanVerbs.openThread({
      jobId: 'job-1',
      role: EThreadRole.ci,
      cwd: '/repo',
    });
    expect(thread.status).toBe(EThreadStatus.active);
  });
});

describe('close a thread by hand', () => {
  it('closes the LAST open thread, which the agent may not', async () => {
    const w = world({ phase: EPhaseKind.ci, role: EThreadRole.ship_pr });
    const { cursorThreadId } = await w.humanVerbs.closeThread({
      jobId: 'job-1',
      threadId: 'thread-1',
    });

    expect(w.closed).toEqual(['thread-1']);
    // `lastOpenThreadRefusal` belongs to `complete_thread` alone: a phase with nothing in it is a
    // legal, expected state — it is exactly what a shipped job is.
    expect(cursorThreadId).toBeNull();
  });

  it('stamps abandoned, and invents no resolution', async () => {
    const w = world({ phase: EPhaseKind.planning });
    await w.humanVerbs.closeThread({ jobId: 'job-1', threadId: 'thread-1' });

    // Reserved for exactly this, and unemittable by an agent.
    expect(w.outcomes).toEqual([
      { threadId: 'thread-1', condition: EThreadCondition.abandoned },
    ]);
  });

  it('leaves the cursor where it is when nothing else is open', async () => {
    const w = world({ phase: EPhaseKind.ci, role: EThreadRole.ship_pr });
    await w.humanVerbs.closeThread({ jobId: 'job-1', threadId: 'thread-1' });
    // Clearing `Job.activeThreadId` would make the job unopenable — it is what `openJob` resolves —
    // which is precisely the dead end this ticket closes.
    expect(w.cursor).toEqual([]);
  });

  it('hands the cursor to a sibling when there is one', async () => {
    const w = world({ phase: EPhaseKind.planning });
    const sibling = await w.humanVerbs.openThread({
      jobId: 'job-1',
      role: EThreadRole.research,
      cwd: '/repo',
    });

    const { cursorThreadId } = await w.humanVerbs.closeThread({
      jobId: 'job-1',
      threadId: 'thread-1',
    });
    expect(cursorThreadId).toBe(sibling.id);
    expect(w.cursor.at(-1)).toBe(sibling.id);
  });

  it('cuts a turn still in flight', async () => {
    const w = world({ phase: EPhaseKind.direct_build, role: EThreadRole.builder });
    await w.humanVerbs.closeThread({ jobId: 'job-1', threadId: 'thread-1' });
    // Turns are subprocesses of this process and do not notice a row change, so a close that
    // skipped this would leave an agent writing into a thread that has ended.
    expect(w.interrupted).toEqual(['thread-1']);
  });

  it('refuses a thread that is already closed', async () => {
    const w = world({ phase: EPhaseKind.planning });
    await w.humanVerbs.closeThread({ jobId: 'job-1', threadId: 'thread-1' });
    await expect(
      w.humanVerbs.closeThread({ jobId: 'job-1', threadId: 'thread-1' }),
    ).rejects.toThrow(/already closed/);
  });
});

describe('a shipped job, end to end', () => {
  it('re-enters, and going back to active on the next phase is correct', async () => {
    const w = world({ phase: EPhaseKind.ci, role: EThreadRole.ship_pr });

    // The PR is up and `ship_pr` is done. Dennis closes it himself; the job now has nothing running.
    await w.humanVerbs.closeThread({ jobId: 'job-1', threadId: 'thread-1' });
    expect(w.threads.filter((t) => t.status !== EThreadStatus.closed)).toEqual([]);

    // A red build. Handled in place, in the sitting `ci` phase — no new phase, because `ci` is the
    // named routing target for exactly this.
    const chaser = await w.humanVerbs.openThread({
      jobId: 'job-1',
      role: EThreadRole.ci,
      cwd: '/repo',
    });
    expect(chaser.phaseId).toBe('phase-1');

    // It turns out to be spec-shaped, so it becomes a new phase instead — the prose bar, not a
    // mechanism. `direct_build` is the graph's existing name for *make a change without planning it*.
    await w.humanVerbs.closeThread({ jobId: 'job-1', threadId: chaser.id });
    const { phase, thread } = await w.humanVerbs.startPhase({
      jobId: 'job-1',
      kind: EPhaseKind.direct_build,
      cwd: '/repo',
    });

    expect(w.phases.map((p) => p.kind)).toEqual([
      EPhaseKind.ci,
      EPhaseKind.direct_build,
    ]);
    expect(phase.ordinal).toBe(1);
    expect(thread.status).toBe(EThreadStatus.active);
  });
});
