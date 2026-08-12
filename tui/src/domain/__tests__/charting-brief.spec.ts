import { describe, expect, it } from 'bun:test';
import { EPhaseKind } from '../../generated/prisma/enums.js';
import { chartingBrief } from '../charting-brief.js';
import type { PhaseBriefContext } from '../phase-brief.js';

const CONTEXT_ROOT = '/Users/dennis/.atlas/jobs/job-1/context';

function ctx(over: Partial<PhaseBriefContext> = {}): PhaseBriefContext {
  return {
    kind: EPhaseKind.charting,
    ordinal: 0,
    repeat: false,
    jobTitle: 'add avatar upload',
    contextRoot: CONTEXT_ROOT,
    ...over,
  };
}

/**
 * Charting's instructions are wayfinder, vendored at `.scratch/session-orchestration/sources/
 * wayfinder-SKILL.md` and rewritten for Atlas. The rules below are the ones the source calls
 * load-bearing, so a rewrite that quietly drops one is the failure this catches — the prose is a
 * tuning surface and will be edited often, and "still says the thing" is what must survive editing.
 *
 * It asserts on CONCEPTS, not on sentences: matching the source's wording would make every
 * improvement to the prose a test failure, which is how a test stops being read.
 */
describe('the charting brief is wayfinder', () => {
  const { instructions } = chartingBrief(ctx());

  it('names the destination as what charting is for', () => {
    expect(instructions).toContain('destination');
    expect(instructions).toContain('Destination');
  });

  it('says plan, don’t do', () => {
    expect(instructions.toLowerCase()).toContain('plan');
    expect(instructions).toContain('decisions, not deliverables');
  });

  it('carries all five map sections — Out of scope is a mechanic, not decoration', () => {
    for (const section of [
      '## Destination',
      '## Notes',
      '## Decisions so far',
      '## Not yet specified',
      '## Out of scope',
    ]) {
      expect(instructions).toContain(section);
    }
  });

  it('carries the fog-vs-ticket test in its sharp form', () => {
    expect(instructions).toContain('state the question precisely');
    expect(instructions).toContain('*not* whether');
  });

  it('keeps one ticket per thread, with research the exception', () => {
    expect(instructions).toContain('One ticket per thread');
    expect(instructions).toContain('research excepted');
  });

  it('says refer to a ticket by name, with the number riding inside it', () => {
    expect(instructions).toContain('never by a bare number');
  });

  it('makes writing the answer and the map line a precondition of moving on', () => {
    expect(instructions).toContain('precondition of moving on');
  });

  it('says a ticket is a file and a thread is the claim', () => {
    expect(instructions).toContain('a thread is the claim');
    expect(instructions).toContain('has no thread at all');
  });

  it('carries `Blocked by:` on tickets, which 03 had dropped', () => {
    expect(instructions).toContain('Blocked by:');
  });

  it('maps wayfinder’s ticket types onto Atlas roles and the thread/teammate tier', () => {
    for (const type of ['grilling', 'research', 'prototype', 'task']) {
      expect(instructions).toContain(type);
    }
    expect(instructions).toContain('teammate');
    // The participation test, which is what decides the tier.
    expect(instructions).toContain('without him saying a word');
  });

  it('names the moves as tools, and forbids simulating one that is absent', () => {
    for (const tool of [
      'advance_thread',
      'open_thread',
      'open_teammate',
      'complete_thread',
      'advance_phase',
    ]) {
      expect(instructions).toContain(tool);
    }
    expect(instructions).toContain('Never simulate a');
  });

  it('points at the job’s own folder, absolutely — file tools do not expand $VARS', () => {
    expect(instructions).toContain(`${CONTEXT_ROOT}/charting/map.md`);
    expect(instructions).not.toContain('$ATLAS');
  });

  it('writes a map even when charting produces no tickets', () => {
    expect(instructions).toContain('always written');
  });
});

describe('the charting opening', () => {
  const first = chartingBrief(ctx());
  const escalated = chartingBrief(ctx({ ordinal: 1, previous: EPhaseKind.generic }));
  const reentered = chartingBrief(
    ctx({ ordinal: 3, previous: EPhaseKind.post_build, repeat: true }),
  );

  it('opens a first charting on the job title, with nothing charted yet', () => {
    expect(first.opening).toContain('add avatar upload');
    expect(first.opening).toContain('Nothing has been charted');
  });

  it('opens a re-entered charting on the map that already exists', () => {
    expect(reentered.opening).toContain('already a map');
    expect(reentered.opening).toContain(`${CONTEXT_ROOT}/charting/map.md`);
  });

  /**
   * The repair. `repeat` is the ONLY safe test for "a map exists", because charting is the only
   * writer of one — the old `repeat || previous !== undefined` sent every escalation to read a file
   * that had never been written.
   */
  it('tells a charting escalated out of generic that there is no map, and to chart from the handoff', () => {
    expect(escalated.opening).toContain('no map');
    expect(escalated.opening).toContain('handoff');
    expect(escalated.opening).not.toContain('already a map');
  });

  /**
   * Three arrivals, three openings. Asserted as a set so that a fourth phase added in front of this
   * one collapses two branches loudly rather than quietly lying to one of them.
   */
  it('keeps the three openings distinct', () => {
    const openings = [first.opening, escalated.opening, reentered.opening];
    expect(new Set(openings).size).toBe(3);
    // The standing instructions do not move with the entry point — that is the phase's identity.
    expect(new Set([first.instructions, escalated.instructions, reentered.instructions]).size).toBe(
      1,
    );
  });
});
