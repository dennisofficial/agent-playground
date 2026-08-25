import { describe, expect, it } from 'bun:test';
import { EPhaseKind } from '../../generated/prisma/enums.js';
import { phaseBriefContext, type PhaseBriefContext } from '../phase-brief.js';

const CONTEXT_ROOT = '/Users/dennis/.atlas/jobs/job-1/context';

describe('phaseBriefContext', () => {
  // Ordinal 0 is `generic` because every job opens there now — the phase list a real job carries.
  const phases = [
    { id: 'p0', kind: EPhaseKind.generic, ordinal: 0 },
    { id: 'p1', kind: EPhaseKind.planning, ordinal: 1 },
    { id: 'p2', kind: EPhaseKind.direct_build, ordinal: 2 },
    { id: 'p3', kind: EPhaseKind.post_build, ordinal: 3 },
    { id: 'p4', kind: EPhaseKind.ci, ordinal: 4 },
    { id: 'p5', kind: EPhaseKind.direct_build, ordinal: 5 },
  ];

  const build = (phaseId: string, branch?: string | null): PhaseBriefContext =>
    phaseBriefContext({
      phases,
      phaseId,
      jobTitle: 'add avatar upload',
      contextRoot: CONTEXT_ROOT,
      ...(branch === undefined ? {} : { branch }),
    });

  it('reads the predecessor and the repeat off the append-only list', () => {
    expect(build('p5')).toMatchObject({
      kind: EPhaseKind.direct_build,
      ordinal: 5,
      previous: EPhaseKind.ci,
      repeat: true,
    });
  });

  it('gives the first phase no predecessor — there is nothing it came out of', () => {
    const first = build('p0');
    expect(first.previous).toBeUndefined();
    expect(first.repeat).toBe(false);
  });

  // The escalation shape: a phase that came out of `generic` says so, which is what both the
  // charting and the planning brief now branch on instead of assuming they were first.
  it('names generic as the predecessor of the phase a job escalates into', () => {
    expect(build('p1').previous).toBe(EPhaseKind.generic);
  });

  it('does not call a kind a repeat on its first run', () => {
    expect(build('p2').repeat).toBe(false);
  });

  it('omits a branch the job does not have rather than carrying null into the prose', () => {
    expect(build('p2', null).branch).toBeUndefined();
    expect(build('p2', 'atlas/x').branch).toBe('atlas/x');
  });

  it('throws when the phase is not on the job — a brief for nowhere is not a thing', () => {
    expect(() => build('nope')).toThrow('not on this job');
  });
});
