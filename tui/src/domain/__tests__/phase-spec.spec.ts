import { describe, expect, it } from 'bun:test';
import { EPhaseKind, EThreadRole } from '../../generated/prisma/enums.js';
import type { PhaseBriefContext } from '../phase-brief.js';
import {
  PHASE_SPECS,
  briefFor,
  nextPhasesFor,
  rolesFor,
  type ContextFileRef,
} from '../phase-spec.js';

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

describe('the phase graph', () => {
  // The graph as locked. Written out here rather than derived from the table so that changing an
  // edge has to be a deliberate two-place edit — this IS the pipeline, and it moving by accident is
  // the failure worth catching.
  const EDGES: Record<EPhaseKind, EPhaseKind[]> = {
    generic: [EPhaseKind.charting, EPhaseKind.planning],
    charting: [EPhaseKind.planning, EPhaseKind.design],
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

  /**
   * Two roles, in this order. `ship_pr` leads because a phase opens with its first role, and `ci` is
   * kept NAMED rather than folded into `builder` because it is the routing target for when webhooks
   * eventually land — minting a role at that point would be a migration.
   */
  it('declares both ci roles: the shipping one, and the one a red build is handled in', () => {
    expect(rolesFor(EPhaseKind.ci)).toEqual([EThreadRole.ship_pr, EThreadRole.ci]);
  });

  /**
   * `generic` is every job's entry point and nothing else may propose it: dropping a job back into
   * un-postured conversation is a human judgement, and start-a-phase already reaches any phase. An
   * edge added here would make it something the agent could do to itself.
   */
  it('lets nothing point back at generic — it is entered, never proposed', () => {
    for (const kind of Object.values(EPhaseKind)) {
      expect(nextPhasesFor(kind)).not.toContain(EPhaseKind.generic);
    }
  });

  /**
   * The most consequential property of this table is which boundaries stop for the human, and the
   * answer is now ALL of them. This asserts the absence of the setting rather than its value: a
   * one-valued `confirm` field would be an invitation to reintroduce the fork, and a job that had
   * already moved on is how you would find out it came back.
   */
  it('carries no per-phase confirm setting — every boundary stops for the human', () => {
    for (const kind of Object.values(EPhaseKind)) {
      expect(PHASE_SPECS[kind]).not.toHaveProperty('confirm');
    }
  });
});

describe('roles', () => {
  it('gives generic the same four types charting has — research here costs no phase advance', () => {
    expect(rolesFor(EPhaseKind.generic)).toEqual([
      EThreadRole.generic,
      EThreadRole.research,
      EThreadRole.prototype,
      EThreadRole.task,
    ]);
  });

  it('gives charting wayfinder’s four ticket types', () => {
    expect(rolesFor(EPhaseKind.charting)).toEqual([
      EThreadRole.charting,
      EThreadRole.research,
      EThreadRole.prototype,
      EThreadRole.task,
    ]);
  });

  it('lets planning host a charting thread — fog found while planning never goes back a phase', () => {
    expect(rolesFor(EPhaseKind.planning)).toContain(EThreadRole.charting);
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
    { bucket: 'charting', path: 'map.md' },
    { bucket: 'charting', path: '03-where-does-crop-run.md' },
    { bucket: 'specs', path: 'spec.md' },
    { bucket: 'specs', path: 'data-model.md' },
    { bucket: 'specs', path: '01-upload-and-see-it.md' },
    { bucket: 'specs', path: 'notes/scratch.md' },
    { bucket: 'artifacts', path: 'design-bundle.md' },
  ];

  it('floors planning on the map, not on twelve resolved tickets', () => {
    expect(PHASE_SPECS[EPhaseKind.planning].attach(files)).toEqual([
      { bucket: 'charting', path: 'map.md' },
    ]);
  });

  /**
   * One rule, two behaviours: `generic` takes the ordinary floor rather than an empty function, so
   * a fresh job hands over nothing because the bucket is empty, and a job re-entered after charting
   * hands over the map without anyone declaring it.
   */
  it('floors generic on nothing when the folder is empty, and on the map when it is not', () => {
    expect(PHASE_SPECS[EPhaseKind.generic].attach([])).toEqual([]);
    expect(PHASE_SPECS[EPhaseKind.generic].attach(files)).toEqual([
      { bucket: 'charting', path: 'map.md' },
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
    const brief = briefFor(ctx({ kind: EPhaseKind.planning, previous: EPhaseKind.charting }));
    expect(brief.opening).toContain('add avatar upload');
    expect(brief.instructions).toContain(`${CONTEXT_ROOT}/charting/map.md`);
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
