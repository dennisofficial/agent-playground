import { describe, expect, it } from 'bun:test';
import { EPhaseKind, EThreadRole } from '../../generated/prisma/enums.js';
import {
  EPhaseConfirm,
  PHASE_SPECS,
  briefFor,
  nextPhasesFor,
  phaseBriefContext,
  rolesFor,
  type ContextFileRef,
  type PhaseBriefContext,
} from '../phase-spec.js';

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

describe('the phase graph', () => {
  // The graph as locked. Written out here rather than derived from the table so that changing an
  // edge has to be a deliberate two-place edit — this IS the pipeline, and it moving by accident is
  // the failure worth catching.
  const EDGES: Record<EPhaseKind, EPhaseKind[]> = {
    intake: [EPhaseKind.planning, EPhaseKind.design],
    design: [EPhaseKind.planning],
    planning: [EPhaseKind.build, EPhaseKind.direct_build, EPhaseKind.design],
    build: [EPhaseKind.master_review, EPhaseKind.planning],
    direct_build: [EPhaseKind.post_build],
    master_review: [EPhaseKind.post_build],
    post_build: [EPhaseKind.planning, EPhaseKind.design, EPhaseKind.ci],
    ci: [],
  };

  it('offers exactly the locked edges, in menu order', () => {
    for (const [kind, next] of Object.entries(EDGES)) {
      expect(nextPhasesFor(kind as EPhaseKind)).toEqual(next);
    }
  });

  it('declares every phase kind — a kind with no spec is a job that cannot advance into it', () => {
    for (const kind of Object.values(EPhaseKind)) {
      expect(PHASE_SPECS[kind].kind).toBe(kind);
    }
  });

  it('leaves ci absorbing: it proposes nothing, and re-entry is the human’s verb', () => {
    expect(nextPhasesFor(EPhaseKind.ci)).toHaveLength(0);
  });

  it('asks before entering every phase — a boundary is a human boundary', () => {
    for (const kind of Object.values(EPhaseKind)) {
      expect(PHASE_SPECS[kind].confirm).toBe(EPhaseConfirm.ask);
    }
  });
});

describe('roles', () => {
  it('gives intake wayfinder’s four ticket types', () => {
    expect(rolesFor(EPhaseKind.intake)).toEqual([
      EThreadRole.intake,
      EThreadRole.research,
      EThreadRole.prototype,
      EThreadRole.task,
    ]);
  });

  it('lets planning host an intake thread — fog found while planning never goes back a phase', () => {
    expect(rolesFor(EPhaseKind.planning)).toContain(EThreadRole.intake);
  });

  it('names a real role everywhere — this is the only role list in the app', () => {
    const roles = new Set<string>(Object.values(EThreadRole));
    for (const kind of Object.values(EPhaseKind)) {
      expect(rolesFor(kind).length).toBeGreaterThan(0);
      for (const role of rolesFor(kind)) expect(roles.has(role)).toBe(true);
    }
  });
});

describe('attach — the structural floor', () => {
  const files: ContextFileRef[] = [
    { bucket: 'intake', path: 'map.md' },
    { bucket: 'intake', path: '03-where-does-crop-run.md' },
    { bucket: 'specs', path: 'spec.md' },
    { bucket: 'specs', path: 'data-model.md' },
    { bucket: 'specs', path: '01-upload-and-see-it.md' },
    { bucket: 'specs', path: 'notes/scratch.md' },
    { bucket: 'artifacts', path: 'design-bundle.md' },
  ];

  it('floors planning on the map, not on twelve resolved tickets', () => {
    expect(PHASE_SPECS[EPhaseKind.planning].attach(files)).toEqual([
      { bucket: 'intake', path: 'map.md' },
    ]);
  });

  it('floors a build on every unnumbered spec — numbered files are one thread’s each', () => {
    expect(PHASE_SPECS[EPhaseKind.build].attach(files)).toEqual([
      { bucket: 'specs', path: 'spec.md' },
      { bucket: 'specs', path: 'data-model.md' },
    ]);
  });

  it('never floors artifacts, and never reaches into a nested bundle', () => {
    for (const kind of Object.values(EPhaseKind)) {
      const floored = PHASE_SPECS[kind].attach(files);
      expect(floored.some((file) => file.bucket === 'artifacts')).toBe(false);
      expect(floored.some((file) => file.path.includes('/'))).toBe(false);
    }
  });
});

describe('brief(ctx)', () => {
  it('is a function of context — the same kind opens differently from different places', () => {
    const cold = briefFor(
      ctx({ kind: EPhaseKind.direct_build, ordinal: 1, previous: EPhaseKind.planning }),
    );
    const red = briefFor(
      ctx({ kind: EPhaseKind.direct_build, ordinal: 4, previous: EPhaseKind.ci, repeat: true }),
    );

    expect(red.opening).not.toBe(cold.opening);
    expect(red.opening).toContain('red build');
    // The standing instructions do NOT move with the entry point: they are the phase's identity,
    // and a re-entry that changed them would be a second phase kind wearing the same name.
    expect(red.instructions).toBe(cold.instructions);
  });

  it('names the job and absolute paths — file tools do not expand env vars', () => {
    const brief = briefFor(ctx({ kind: EPhaseKind.planning, previous: EPhaseKind.intake }));
    expect(brief.opening).toContain('add avatar upload');
    expect(brief.instructions).toContain(`${CONTEXT_ROOT}/intake/map.md`);
    expect(brief.instructions).not.toContain('$ATLAS');
  });

  it('tells a build which branch it is on, and says so when there is none', () => {
    const onBranch = briefFor(ctx({ kind: EPhaseKind.build, branch: 'atlas/add-avatar-upload' }));
    expect(onBranch.instructions).toContain('atlas/add-avatar-upload');
    expect(briefFor(ctx({ kind: EPhaseKind.build })).instructions).toContain('project path');
  });

  it('gives every phase both halves — a phase with no opening would land on a blank thread', () => {
    for (const kind of Object.values(EPhaseKind)) {
      const brief = briefFor(ctx({ kind }));
      expect(brief.instructions.trim().length).toBeGreaterThan(0);
      expect(brief.opening.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('phaseBriefContext', () => {
  const phases = [
    { id: 'p0', kind: EPhaseKind.intake, ordinal: 0 },
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
