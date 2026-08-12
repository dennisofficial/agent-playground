import { describe, expect, it } from 'bun:test';
import { EPhaseKind } from '../../generated/prisma/enums.js';
import { intakeBrief } from '../intake-brief.js';
import type { PhaseBriefContext } from '../phase-spec.js';

const CONTEXT_ROOT = '/Users/dennis/.atlas/jobs/job-1/context';

function ctx(over: Partial<PhaseBriefContext> = {}): PhaseBriefContext {
  return {
    kind: EPhaseKind.intake,
    ordinal: 0,
    repeat: false,
    jobTitle: 'add avatar upload',
    contextRoot: CONTEXT_ROOT,
    ...over,
  };
}

/**
 * Intake's instructions are wayfinder, vendored at `.scratch/session-orchestration/sources/
 * wayfinder-SKILL.md` and rewritten for Atlas. The rules below are the ones the source calls
 * load-bearing, so a rewrite that quietly drops one is the failure this catches — the prose is a
 * tuning surface and will be edited often, and "still says the thing" is what must survive editing.
 *
 * It asserts on CONCEPTS, not on sentences: matching the source's wording would make every
 * improvement to the prose a test failure, which is how a test stops being read.
 */
describe('the intake brief is wayfinder', () => {
  const { instructions } = intakeBrief(ctx());

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
    expect(instructions).toContain(`${CONTEXT_ROOT}/intake/map.md`);
    expect(instructions).not.toContain('$ATLAS');
  });

  it('writes a map even when charting produces no tickets', () => {
    expect(instructions).toContain('always written');
  });
});

describe('the intake opening', () => {
  it('opens a first intake on the job title, with nothing charted yet', () => {
    const { opening } = intakeBrief(ctx());
    expect(opening).toContain('add avatar upload');
    expect(opening).toContain('Nothing has been charted');
  });

  it('opens a re-entered intake on the map that already exists', () => {
    const { opening } = intakeBrief(
      ctx({ ordinal: 3, previous: EPhaseKind.post_build, repeat: true }),
    );
    expect(opening).toContain('already a map');
    expect(opening).toContain(`${CONTEXT_ROOT}/intake/map.md`);
  });
});
