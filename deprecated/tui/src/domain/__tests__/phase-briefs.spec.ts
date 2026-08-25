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
 * The `ci` brief carries the whole shipping procedure, because Atlas stopped shipping. There is no
 * tool that rebases and pushes any more, so every rule that used to be enforced inside one — do not
 * force-push, do not open a second pull request, do not push to the default branch — is prose here
 * or is nowhere. These tests are that prose's only guard.
 */
describe('the ci brief, which ships and does not watch', () => {
  const ciCtx = (over: Partial<PhaseBriefContext> = {}): PhaseBriefContext =>
    ctx({ kind: EPhaseKind.ci, previous: EPhaseKind.post_build, branch: 'atlas/x', ...over });

  /**
   * The rule the whole change exists to state. Atlas used to force-push on the agent's behalf on
   * every re-ship; now nothing structurally prevents one, so the brief has to, in words, unhedged.
   */
  it('forbids force-pushing, in every spelling of it', () => {
    const brief = ciBrief(ciCtx());
    expect(brief.instructions).toContain('**Never force-push.**');
    expect(brief.instructions).toContain('--force-with-lease');
    // A rejected push is information, and the failure mode is reaching for a flag that hides it.
    expect(brief.instructions).toContain('never to overwrite it');
  });

  it('says shipping is the agent\'s own git work, not the harness\'s', () => {
    const brief = ciBrief(ciCtx());
    expect(brief.instructions).toContain('Atlas does not');
    expect(brief.instructions).toContain('runs no git');
    // And names the one call that IS Atlas's, so the render cache keeps a writer.
    expect(brief.instructions).toContain('record_pr');
    expect(brief.opening).toContain('record_pr');
  });

  it('makes rebasing conditional and names it as the cause of a force push', () => {
    const brief = ciBrief(ciCtx());
    expect(brief.instructions).toContain('Rebasing is **not** part of shipping');
    expect(brief.instructions).toContain('a reason you can name');
    // The causal link, spelled out: this is why the two rules are one rule.
    expect(brief.instructions).toContain('rebasing a pushed branch');
    // A branch merely behind base is fine — the old tool rebased unconditionally and that is what
    // made every re-ship a rewrite.
    expect(brief.instructions).toContain('merely behind is fine');
  });

  it('orders the ask-before-you-create check, so a re-ship opens no second pull request', () => {
    const brief = ciBrief(ciCtx());
    const list = brief.instructions.indexOf('gh pr list');
    const create = brief.instructions.indexOf('gh pr create');
    expect(list).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(list);
    expect(brief.instructions).toContain('Only if it comes back');
  });

  it('says nothing watches, and that the phase proposes nothing', () => {
    const brief = ciBrief(ciCtx());
    expect(brief.instructions).toContain('Nothing here watches GitHub');
    expect(brief.instructions).toContain('proposes nothing');
    // The one instruction that would be a lie: there is no watcher to wait for a build with.
    expect(brief.instructions).toContain('may wait for a build');
  });

  it('asks for a record on every ship, not only the one that opened the pull request', () => {
    // Otherwise the render cache only ever gets written once, and a job whose pull request was
    // opened by hand never gets one at all.
    expect(ciBrief(ciCtx({ repeat: true })).instructions).toContain(
      'including the ships that opened nothing new',
    );
  });

  it('tells a re-entered ci phase which pull request it already has', () => {
    const shipped = ciBrief(ciCtx({ repeat: true, prNumber: 12 }));
    expect(shipped.opening).toContain('#12');
    expect(shipped.opening).toContain('should not open a second');
    // No record is NOT the same as no pull request — nothing local watches GitHub and the cache is
    // only as good as the last write, so the opening sends the agent to check rather than assume.
    expect(ciBrief(ciCtx()).opening).toContain('No pull request has been recorded');
    expect(ciBrief(ciCtx()).opening).toContain('check anyway');
  });
});
