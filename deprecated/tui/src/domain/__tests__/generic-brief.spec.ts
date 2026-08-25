import { describe, expect, it } from 'bun:test';
import { EPhaseKind } from '../../generated/prisma/enums.js';
import { genericBrief } from '../generic-brief.js';
import type { PhaseBriefContext } from '../phase-brief.js';

const CONTEXT_ROOT = '/Users/dennis/.atlas/jobs/job-1/context';

function ctx(over: Partial<PhaseBriefContext> = {}): PhaseBriefContext {
  return {
    kind: EPhaseKind.generic,
    ordinal: 0,
    repeat: false,
    jobTitle: 'how does auth work',
    contextRoot: CONTEXT_ROOT,
    ...over,
  };
}

/**
 * Three clauses and no fourth. Asserted on CONCEPTS rather than sentences, like the charting brief:
 * this prose is the tuning surface for how eagerly Atlas proposes a pipeline and will be edited
 * often, so a test that pinned the wording would be deleted the first time it fired.
 *
 * The clauses that must survive editing are the trigger, the choice of target, and the folder rule —
 * plus, in the negative tests below, everything the brief must NOT say.
 */
describe('the generic brief', () => {
  const { instructions } = genericBrief(ctx());

  it('triggers on the ask needing a document to survive, not on size or vibes', () => {
    expect(instructions).toContain('worth writing down');
    expect(instructions).toContain('document');
  });

  it('answers questions and makes changes it can show, without proposing anything', () => {
    expect(instructions).toContain('how something works');
    expect(instructions).toContain('make it');
  });

  it('requires understanding the ask before proposing, and one decline ends it', () => {
    expect(instructions).toContain('never propose off an opening line');
    expect(instructions).toContain('do not propose again');
  });

  it('splits the two targets on what-versus-how, and allows asking instead', () => {
    expect(instructions).toContain('`charting`');
    expect(instructions).toContain('`planning`');
    expect(instructions).toContain('only *how* is open');
    expect(instructions).toContain('ask in a sentence');
  });

  it('makes the proposal a real tool call, not prose that quietly moves the job', () => {
    expect(instructions).toContain('advance_phase');
    expect(instructions).toContain('the human confirms');
  });

  /**
   * `advance_phase` does not exist yet (ticket 11 owns the seam), so the escape hatch is live prose
   * today rather than a hypothetical: an agent that pretends to call an absent tool escalates a job
   * that never moved. Same hatch, same wording as the charting brief.
   */
  it('forbids simulating the proposal when the tool is absent', () => {
    expect(instructions).toContain('Never simulate a move you cannot make');
  });

  it('grants the whole context folder for reading, one writer per unnumbered file', () => {
    expect(instructions).toContain(CONTEXT_ROOT);
    expect(instructions).toContain('exactly **one writer**');
    expect(instructions).toContain('Anyone may add a numbered file');
    expect(instructions).toContain(`${CONTEXT_ROOT}/charting/NN-<slug>.md`);
    expect(instructions).toContain(`${CONTEXT_ROOT}/artifacts/`);
  });

  it('forbids writing the map — a map from here would claim the job had been charted', () => {
    expect(instructions).toContain(`Never write \`${CONTEXT_ROOT}/charting/map.md\``);
  });

  it('names absolute paths, because file tools do not expand $VARS', () => {
    expect(instructions).not.toContain('$ATLAS');
  });

  /**
   * The absences are load-bearing. A generic thread that fixes a typo in place is the cheap path
   * working as intended, and any instruction to chart, to plan, or to check first would turn every
   * question into a stance — which is the exact failure this phase exists to remove.
   */
  it('does not tell it to chart, to plan, or to hold back from editing code', () => {
    expect(instructions).not.toContain('chart the way');
    expect(instructions).not.toContain('Do not edit');
    expect(instructions).not.toContain('before you touch');
    expect(instructions).not.toContain('ask before making');
  });
});

describe('the generic opening', () => {
  /**
   * Unreachable on a job's first phase — nothing is seeded there, the transcript opens on what the
   * human typed. It is still written, and still asserted, because start-a-phase reaches `generic` on
   * a job that already has history and that thread has no human message to open on.
   */
  it('opens a fresh job on the job title, with nothing decided yet', () => {
    const { opening } = genericBrief(ctx());
    expect(opening).toContain('how does auth work');
    expect(opening).toContain('Nothing has been decided');
  });

  it('opens a generic phase started on an existing job on the handoff behind it', () => {
    const { opening } = genericBrief(ctx({ ordinal: 4, previous: EPhaseKind.post_build }));
    expect(opening).toContain('post build');
    expect(opening).toContain('handoff');
    expect(opening).not.toContain('Nothing has been decided');
  });

  it('says the same standing instructions either way — the entry point is not the identity', () => {
    expect(genericBrief(ctx({ previous: EPhaseKind.ci })).instructions).toBe(
      genericBrief(ctx()).instructions,
    );
  });
});
