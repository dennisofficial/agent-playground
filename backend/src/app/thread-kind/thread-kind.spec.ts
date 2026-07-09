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
 * validator must fail loudly on the misconfigurations it guards (unknown Agent / laneKind / child kind).
 */
describe('thread-kind registry', () => {
  it('the real registry passes boot validation (every kind binds a valid Agent + laneKind; children resolve)', () => {
    expect(() => validateThreadKinds()).not.toThrow();
  });

  it('defines all six kinds exactly once', () => {
    const kinds = THREAD_KIND_SPECS.map((s) => s.kind).sort();
    expect(kinds).toEqual(
      ['builder', 'main', 'master_review', 'plan_review', 'post_review', 'review_lens'].sort(),
    );
  });

  it('only builder + master_review are driver-executable top-level kinds', () => {
    expect([...driverExecutableKinds].sort()).toEqual(['builder', 'master_review']);
    expect(isDriverExecutableKind('builder')).toBe(true);
    expect(isDriverExecutableKind('master_review')).toBe(true);
    expect(isDriverExecutableKind('main')).toBe(false);
    expect(isDriverExecutableKind('review_lens')).toBe(false);
    expect(isDriverExecutableKind('post_review')).toBe(false);
    expect(isDriverExecutableKind('plan_review')).toBe(false);
  });

  it('main + plan_review are render-only; review_lens + post_review are children', () => {
    expect(threadKindSpec('main').execution).toBe('render-only');
    expect(threadKindSpec('plan_review').execution).toBe('render-only');
    expect(threadKindSpec('review_lens').execution).toBe('child');
    expect(threadKindSpec('post_review').execution).toBe('child');
  });

  it("a builder's children are N review_lens + 1 post_review (each a real child spec)", () => {
    const kids = threadKindSpec('builder').children!({ id: 'b1', config: {} });
    const lenses = kids.filter((k) => k.kind === 'review_lens');
    const posts = kids.filter((k) => k.kind === 'post_review');
    expect(lenses.length).toBeGreaterThan(0);
    expect(lenses.every((l) => typeof (l.config as { lensId?: string }).lensId === 'string')).toBe(true);
    expect(posts).toHaveLength(1);
    expect((posts[0].config as { minSeverity?: string }).minSeverity).toBeTruthy();
  });

  it('threadKindSpec throws on an unknown kind', () => {
    expect(() => threadKindSpec('nope')).toThrow(/unknown kind/);
  });

  it('validateThreadKinds rejects an unknown Agent', () => {
    const bad: ThreadKindSpec[] = [
      { ...threadKindSpec('builder'), agent: 'not_an_agent' as unknown as Agent, children: undefined },
    ];
    expect(() => validateThreadKinds(bad)).toThrow(/unknown Agent/);
  });

  it('validateThreadKinds rejects an unknown laneKind', () => {
    const bad: ThreadKindSpec[] = [
      { ...threadKindSpec('builder'), laneKind: 'nonsense' as never, children: undefined },
    ];
    expect(() => validateThreadKinds(bad)).toThrow(/unknown laneKind/);
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
    expect(laneDefaultFooter('main').effort).toBe('high');
    expect(laneDefaultFooter('builder').effort).toBe('high');
    expect(laneDefaultFooter('master_review').effort).toBe('xhigh');
  });

  it('validateThreadKinds rejects a duplicate kind', () => {
    // Strip children so the child-kind check (which would fire first on this 2-element array) doesn't mask
    // the duplicate check we're asserting.
    const leaf: ThreadKindSpec = { ...threadKindSpec('builder'), children: undefined };
    const bad: ThreadKindSpec[] = [leaf, leaf];
    expect(() => validateThreadKinds(bad)).toThrow(/duplicate spec/);
  });
});
