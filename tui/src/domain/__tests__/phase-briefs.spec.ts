import { describe, expect, it } from 'bun:test';
import { EPhaseKind } from '../../generated/prisma/enums.js';
import type { PhaseBriefContext } from '../phase-brief.js';
import { ciBrief, planningBrief } from '../phase-briefs.js';

const CONTEXT_ROOT = '/Users/dennis/.atlas/jobs/job-1/context';
const MAP = `${CONTEXT_ROOT}/charting/map.md`;

function ctx(over: Partial<PhaseBriefContext> = {}): PhaseBriefContext {
  return {
    kind: EPhaseKind.planning,
    ordinal: 2,
    repeat: false,
    jobTitle: 'add avatar upload',
    contextRoot: CONTEXT_ROOT,
    ...over,
  };
}

/**
 * The second repair `generic` forces. Planning used to open "Charting settled what this is" and
 * "Read map.md before you plan" — true only while every job was charted. `generic → planning` is a
 * real edge now, and a planner sent to read a file nobody wrote either invents one or stalls.
 */
describe('the planning brief, which no longer assumes it was charted', () => {
  const charted = planningBrief(ctx({ previous: EPhaseKind.charting }));
  const uncharted = planningBrief(ctx({ ordinal: 1, previous: EPhaseKind.generic }));

  it('stops asserting an origin it may not have', () => {
    expect(charted.instructions).not.toContain('Charting settled what this is');
    expect(charted.instructions).not.toContain('Read ' + MAP + ' before you plan');
  });

  it('opens on the map when the job was charted', () => {
    expect(charted.opening).toContain(MAP);
    expect(charted.opening).not.toContain('never charted');
  });

  it('opens on the handoff when it was not, and says the map is absent out loud', () => {
    expect(uncharted.opening).toContain('never charted');
    expect(uncharted.opening).toContain('handoff');
  });

  /**
   * Not writing the map is the load-bearing half: a second writer for that file would make the
   * planner transcribe a conversation it did not have, and would claim the job had been charted.
   */
  it('forbids writing the map to fill the gap', () => {
    expect(uncharted.instructions).toContain('do NOT write a map');
    expect(uncharted.instructions).toContain('one writer');
  });

  it('keeps its standing instructions identical from either origin', () => {
    expect(uncharted.instructions).toBe(charted.instructions);
  });
});

/**
 * The `ci` brief has one job beyond the usual: naming the tool. Shipping is a single call that does
 * the rebase, the push and the does-one-exist check, and an agent told only "push and open a PR"
 * runs git itself and does none of those.
 */
describe('the ci brief, which ships and does not watch', () => {
  const ciCtx = (over: Partial<PhaseBriefContext> = {}): PhaseBriefContext =>
    ctx({ kind: EPhaseKind.ci, previous: EPhaseKind.post_build, branch: 'atlas/x', ...over });

  it('names the tool and forbids doing it by hand', () => {
    const brief = ciBrief(ciCtx());
    expect(brief.instructions).toContain('ship_pr');
    expect(brief.instructions).toContain('Do not run git or gh yourself');
    expect(brief.opening).toContain('ship_pr');
  });

  it('says nothing watches, and that the phase proposes nothing', () => {
    const brief = ciBrief(ciCtx());
    expect(brief.instructions).toContain('Nothing here watches GitHub');
    expect(brief.instructions).toContain('proposes nothing');
    // The one instruction that would be a lie: there is no watcher to wait for a build with.
    expect(brief.instructions).toContain('may wait for a build');
  });

  it('says re-calling it is the intended way to re-ship', () => {
    expect(ciBrief(ciCtx({ repeat: true })).instructions).toContain('Calling it again is harmless');
  });

  it('tells a re-entered ci phase which pull request it already has', () => {
    const shipped = ciBrief(ciCtx({ repeat: true, prNumber: 12 }));
    expect(shipped.opening).toContain('#12');
    expect(shipped.opening).toContain('rather than open a second');
    // The render cache is absent until something ships, and the opening must not imply one exists.
    expect(ciBrief(ciCtx()).opening).toContain('No pull request has been opened');
  });
});
