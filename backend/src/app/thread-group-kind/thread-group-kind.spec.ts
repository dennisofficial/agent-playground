import { describe, expect, it } from 'vitest';
import {
  THREAD_GROUP_KIND_SPECS,
  coerceThreadGroupKind,
  threadGroupKindSpec,
  validateThreadGroupKinds,
} from './registry';
import type { ThreadGroupKindSpec } from './spec';

/**
 * The twin of `thread-kind.spec.ts`: the real registry must pass boot validation, and the validator must
 * fail loudly on the misconfigurations it guards (duplicate kind, a role naming an unknown ThreadRole).
 */
describe('thread-group-kind registry', () => {
  it('the real registry passes boot validation (every role resolves to a ThreadKindSpec)', () => {
    expect(() => validateThreadGroupKinds()).not.toThrow();
  });

  it('defines all five thread-group kinds exactly once', () => {
    const kinds = THREAD_GROUP_KIND_SPECS.map((s) => s.kind).sort();
    expect(kinds).toEqual(['planning', 'section', 'master_review', 'post_build', 'ship'].sort());
  });

  it('section contains sequential builder legs (d1) + 0..N review_agent + exactly one review_fix', () => {
    const spec = threadGroupKindSpec('section');
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

  it('planning requires a title (round disambiguation); other singleton kinds do not', () => {
    expect(threadGroupKindSpec('planning').titleRequired).toBe(true);
    for (const kind of ['master_review', 'post_build', 'ship'] as const) {
      expect(threadGroupKindSpec(kind).titleRequired).toBe(false);
    }
  });

  it('each single-role singleton kind declares exactly one role, min 1 max 1', () => {
    for (const kind of ['master_review', 'post_build', 'ship'] as const) {
      const spec = threadGroupKindSpec(kind);
      expect(spec.roles).toHaveLength(1);
      expect(spec.roles[0].min).toBe(1);
      expect(spec.roles[0].max).toBe(1);
    }
  });

  it('planning declares its required planner (min 1 max 1) + optional codex_review (min 0 max 1), d10', () => {
    const spec = threadGroupKindSpec('planning');
    const planner = spec.roles.find((r) => r.role === 'planner')!;
    expect(planner).toEqual({ role: 'planner', min: 1, max: 1 });
    const codexReview = spec.roles.find((r) => r.role === 'codex_review')!;
    expect(codexReview).toEqual({ role: 'codex_review', min: 0, max: 1 });
  });

  it('spawnAt names the orchestration seam for every kind', () => {
    expect(threadGroupKindSpec('planning').spawnAt).toBe('job_start');
    expect(threadGroupKindSpec('section').spawnAt).toBe('dispatch');
    expect(threadGroupKindSpec('master_review').spawnAt).toBe('after_build_thread_groups');
    expect(threadGroupKindSpec('post_build').spawnAt).toBe('after_master_review');
    expect(threadGroupKindSpec('ship').spawnAt).toBe('after_ship');
  });

  it('threadGroupKindSpec throws on an unknown kind', () => {
    expect(() => threadGroupKindSpec('nope')).toThrow(/unknown kind/);
  });

  describe('coerceThreadGroupKind', () => {
    it('passes through every valid kind unchanged', () => {
      for (const kind of THREAD_GROUP_KIND_SPECS.map((s) => s.kind)) {
        expect(coerceThreadGroupKind(kind)).toBe(kind);
      }
    });

    it('throws on an unrecognized value (strict, unlike ThreadType\'s "general" fallback)', () => {
      expect(() => coerceThreadGroupKind('bogus')).toThrow(/not a valid ThreadGroupKind/);
      expect(() => coerceThreadGroupKind('')).toThrow(/not a valid ThreadGroupKind/);
      expect(() => coerceThreadGroupKind(undefined)).toThrow(/not a valid ThreadGroupKind/);
      expect(() => coerceThreadGroupKind(null)).toThrow(/not a valid ThreadGroupKind/);
    });
  });

  it('validateThreadGroupKinds rejects a duplicate kind', () => {
    const leaf = threadGroupKindSpec('planning');
    const bad: ThreadGroupKindSpec[] = [leaf, leaf];
    expect(() => validateThreadGroupKinds(bad)).toThrow(/duplicate/);
  });

  it('validateThreadGroupKinds rejects a kind with no roles', () => {
    const bad: ThreadGroupKindSpec[] = [{ ...threadGroupKindSpec('planning'), roles: [] }];
    expect(() => validateThreadGroupKinds(bad)).toThrow(/declares no roles/);
  });

  it('validateThreadGroupKinds rejects a role naming an unknown ThreadRole', () => {
    const bad: ThreadGroupKindSpec[] = [
      {
        ...threadGroupKindSpec('planning'),
        roles: [{ role: 'ghost' as never, min: 1, max: 1 }],
      },
    ];
    expect(() => validateThreadGroupKinds(bad)).toThrow(/unknown role "ghost"/);
  });

  it('validateThreadGroupKinds rejects a role with max < min', () => {
    const bad: ThreadGroupKindSpec[] = [
      {
        ...threadGroupKindSpec('planning'),
        roles: [{ role: 'planner', min: 2, max: 1 }],
      },
    ];
    expect(() => validateThreadGroupKinds(bad)).toThrow(/max < min/);
  });
});
