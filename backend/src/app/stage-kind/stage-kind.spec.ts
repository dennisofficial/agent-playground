import { describe, expect, it } from 'vitest';
import {
  STAGE_KIND_SPECS,
  coerceStageKind,
  stageKindSpec,
  validateStageKinds,
} from './registry';
import type { StageKindSpec } from './spec';

/**
 * The twin of `thread-kind.spec.ts`: the real registry must pass boot validation, and the validator must
 * fail loudly on the misconfigurations it guards (duplicate kind, a role naming an unknown ThreadRole).
 */
describe('stage-kind registry', () => {
  it('the real registry passes boot validation (every role resolves to a ThreadKindSpec)', () => {
    expect(() => validateStageKinds()).not.toThrow();
  });

  it('defines all seven stage kinds exactly once', () => {
    const kinds = STAGE_KIND_SPECS.map((s) => s.kind).sort();
    expect(kinds).toEqual(
      [
        'build',
        'ci',
        'direct_build',
        'master_review',
        'planning',
        'plan_review',
        'post_build',
      ].sort(),
    );
  });

  it('build contains sequential builder legs (d1) + 0..N review_agent + exactly one review_fix', () => {
    const spec = stageKindSpec('build');
    expect(spec.hasReview).toBe(true);
    expect(spec.titleRequired).toBe(true);
    expect(spec.spawnAt).toBe('dispatch');
    const builder = spec.roles.find((r) => r.role === 'builder')!;
    expect(builder.min).toBe(1);
    expect(builder.max).toBeNull();
    const reviewAgent = spec.roles.find((r) => r.role === 'review_agent')!;
    expect(reviewAgent.min).toBe(0);
    expect(reviewAgent.max).toBeNull();
    const reviewFix = spec.roles.find((r) => r.role === 'review_fix')!;
    expect(reviewFix).toEqual({ role: 'review_fix', min: 1, max: 1 });
  });

  it('direct_build is the no-review fast path (d9): a single builder, no review roles, no title', () => {
    const spec = stageKindSpec('direct_build');
    expect(spec.hasReview).toBe(false);
    expect(spec.titleRequired).toBe(false);
    expect(spec.roles).toEqual([{ role: 'builder', min: 1, max: 1 }]);
  });

  it('planning requires a title (round disambiguation); other singleton kinds do not', () => {
    expect(stageKindSpec('planning').titleRequired).toBe(true);
    for (const kind of [
      'plan_review',
      'master_review',
      'post_build',
      'ci',
    ] as const) {
      expect(stageKindSpec(kind).titleRequired).toBe(false);
    }
  });

  it('each singleton kind declares exactly one role, min 1 max 1', () => {
    for (const kind of [
      'planning',
      'plan_review',
      'master_review',
      'post_build',
      'ci',
    ] as const) {
      const spec = stageKindSpec(kind);
      expect(spec.roles).toHaveLength(1);
      expect(spec.roles[0].min).toBe(1);
      expect(spec.roles[0].max).toBe(1);
    }
  });

  it('spawnAt names the orchestration seam for every kind', () => {
    expect(stageKindSpec('planning').spawnAt).toBe('job_start');
    expect(stageKindSpec('plan_review').spawnAt).toBe('plan');
    expect(stageKindSpec('build').spawnAt).toBe('dispatch');
    expect(stageKindSpec('direct_build').spawnAt).toBe('dispatch');
    expect(stageKindSpec('master_review').spawnAt).toBe('after_build_stages');
    expect(stageKindSpec('post_build').spawnAt).toBe('after_master_review');
    expect(stageKindSpec('ci').spawnAt).toBe('after_ship');
  });

  it('stageKindSpec throws on an unknown kind', () => {
    expect(() => stageKindSpec('nope')).toThrow(/unknown kind/);
  });

  describe('coerceStageKind', () => {
    it('passes through every valid kind unchanged', () => {
      for (const kind of STAGE_KIND_SPECS.map((s) => s.kind)) {
        expect(coerceStageKind(kind)).toBe(kind);
      }
    });

    it('throws on an unrecognized value (strict, unlike ThreadType\'s "general" fallback)', () => {
      expect(() => coerceStageKind('bogus')).toThrow(/not a valid StageKind/);
      expect(() => coerceStageKind('')).toThrow(/not a valid StageKind/);
      expect(() => coerceStageKind(undefined)).toThrow(/not a valid StageKind/);
      expect(() => coerceStageKind(null)).toThrow(/not a valid StageKind/);
    });
  });

  it('validateStageKinds rejects a duplicate kind', () => {
    const leaf = stageKindSpec('planning');
    const bad: StageKindSpec[] = [leaf, leaf];
    expect(() => validateStageKinds(bad)).toThrow(/duplicate/);
  });

  it('validateStageKinds rejects a kind with no roles', () => {
    const bad: StageKindSpec[] = [{ ...stageKindSpec('planning'), roles: [] }];
    expect(() => validateStageKinds(bad)).toThrow(/declares no roles/);
  });

  it('validateStageKinds rejects a role naming an unknown ThreadRole', () => {
    const bad: StageKindSpec[] = [
      {
        ...stageKindSpec('planning'),
        roles: [{ role: 'ghost' as never, min: 1, max: 1 }],
      },
    ];
    expect(() => validateStageKinds(bad)).toThrow(/unknown role "ghost"/);
  });

  it('validateStageKinds rejects a role with max < min', () => {
    const bad: StageKindSpec[] = [
      {
        ...stageKindSpec('planning'),
        roles: [{ role: 'planning', min: 2, max: 1 }],
      },
    ];
    expect(() => validateStageKinds(bad)).toThrow(/max < min/);
  });
});
