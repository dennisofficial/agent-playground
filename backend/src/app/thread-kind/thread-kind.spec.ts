import { describe, expect, it } from 'vitest';
import { Agent } from '../prompt-kit';
import {
  THREAD_KIND_SPECS,
  driverExecutableKinds,
  isDriverExecutableKind,
  laneDefaultFooter,
  threadKindSpec,
  validateThreadKinds,
} from './registry';
import type { ThreadKindSpec } from './spec';

/**
 * The twin of prompt-kit's `validateFragments` test: the real registry must pass boot validation, and the
 * validator must fail loudly on the misconfigurations it guards (unknown Agent / child kind).
 */
describe('thread-kind registry', () => {
  it('the real registry passes boot validation (every kind binds a valid Agent; children resolve)', () => {
    expect(() => validateThreadKinds()).not.toThrow();
  });

  it('defines all eight roles exactly once', () => {
    const kinds = THREAD_KIND_SPECS.map((s) => s.kind).sort();
    expect(kinds).toEqual(
      [
        'builder',
        'ship',
        'master_review',
        'planner',
        'codex_review',
        'post_build',
        'review_agent',
        'review_fix',
      ].sort(),
    );
  });

  it('only builder + master_review are driver-executable top-level kinds', () => {
    expect([...driverExecutableKinds].sort()).toEqual(['builder', 'master_review']);
    expect(isDriverExecutableKind('builder')).toBe(true);
    expect(isDriverExecutableKind('master_review')).toBe(true);
    expect(isDriverExecutableKind('planner')).toBe(false);
    expect(isDriverExecutableKind('review_agent')).toBe(false);
    expect(isDriverExecutableKind('review_fix')).toBe(false);
    expect(isDriverExecutableKind('codex_review')).toBe(false);
    expect(isDriverExecutableKind('post_build')).toBe(false);
    expect(isDriverExecutableKind('ship')).toBe(false);
  });

  it('planner/codex_review/post_build/ship are render-only; review_agent + review_fix are children', () => {
    expect(threadKindSpec('planner').execution).toBe('render-only');
    expect(threadKindSpec('codex_review').execution).toBe('render-only');
    expect(threadKindSpec('post_build').execution).toBe('render-only');
    expect(threadKindSpec('ship').execution).toBe('render-only');
    expect(threadKindSpec('review_agent').execution).toBe('child');
    expect(threadKindSpec('review_fix').execution).toBe('child');
  });

  it("a builder's factory owns only the review_fix child — lens selection is the driver's (reviewAgentsForThread)", () => {
    const kids = threadKindSpec('builder').children!({ id: 'b1', config: {} });
    expect(kids.filter((k) => k.kind === 'review_agent')).toHaveLength(0);
    const posts = kids.filter((k) => k.kind === 'review_fix');
    expect(posts).toHaveLength(1);
    expect((posts[0].config as { minSeverity?: string }).minSeverity).toBeTruthy();
  });

  it('threadKindSpec throws on an unknown kind', () => {
    expect(() => threadKindSpec('nope')).toThrow(/unknown kind/);
  });

  it('operatorInput (d12): enabled for builder + planner + post_build + ship, read-only elsewhere by default', () => {
    expect(threadKindSpec('builder').operatorInput).toBe(true);
    expect(threadKindSpec('planner').operatorInput).toBe(true);
    expect(threadKindSpec('post_build').operatorInput).toBe(true);
    expect(threadKindSpec('ship').operatorInput).toBe(true);
    for (const role of ['codex_review', 'review_agent', 'review_fix', 'master_review']) {
      expect(threadKindSpec(role).operatorInput).toBe(false);
    }
  });

  it('validateThreadKinds rejects an unknown Agent', () => {
    const bad: ThreadKindSpec[] = [
      {
        ...threadKindSpec('builder'),
        agent: 'not_an_agent' as unknown as Agent,
        children: undefined,
      },
    ];
    expect(() => validateThreadKinds(bad)).toThrow(/unknown Agent/);
  });

  it('validateThreadKinds rejects a child of unknown kind', () => {
    const bad: ThreadKindSpec[] = [
      {
        ...threadKindSpec('builder'),
        children: () => [{ kind: 'ghost' as never, brief: 'x', config: {} }],
      },
    ];
    expect(() => validateThreadKinds(bad)).toThrow(/unknown kind "ghost"/);
  });

  it("laneDefaultFooter surfaces each kind's reasoning effort — 'high' for the Claude lanes, 'xhigh' for master review", () => {
    expect(laneDefaultFooter('planner').effort).toBe('high');
    expect(laneDefaultFooter('builder').effort).toBe('high');
    expect(laneDefaultFooter('master_review').effort).toBe('xhigh');
  });

  it('validateThreadKinds rejects a duplicate kind', () => {
    // Strip children so the child-kind check (which would fire first on this 2-element array) doesn't mask
    // the duplicate check we're asserting.
    const leaf: ThreadKindSpec = {
      ...threadKindSpec('builder'),
      children: undefined,
    };
    const bad: ThreadKindSpec[] = [leaf, leaf];
    expect(() => validateThreadKinds(bad)).toThrow(/duplicate spec/);
  });
});
