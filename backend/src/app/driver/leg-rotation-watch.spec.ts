import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ROTATION_HARD_TOKENS,
  DEFAULT_ROTATION_SOFT_TOKENS,
  LegRotationWatch,
  type LegRotationSignal,
  resolveRotationThresholds,
} from './leg-rotation-watch';

const THRESHOLDS = { softTokens: 150_000, hardTokens: 200_000 };

function watchCapturing(): { watch: LegRotationWatch; signals: LegRotationSignal[] } {
  const signals: LegRotationSignal[] = [];
  const watch = new LegRotationWatch(THRESHOLDS, (s) => signals.push(s));
  return { watch, signals };
}

describe('LegRotationWatch', () => {
  it('fires SOFT once when occupancy crosses the soft threshold', () => {
    const { watch, signals } = watchCapturing();
    watch.observe({ contextTokens: 120_000, contextLimit: 1_000_000 });
    expect(signals).toHaveLength(0);
    watch.observe({ contextTokens: 150_000, contextLimit: 1_000_000 });
    expect(signals).toEqual([{ phase: 'soft', contextTokens: 150_000, contextLimit: 1_000_000 }]);
    expect(watch.reached).toBe('soft');
  });

  it('does not re-fire SOFT while staying between soft and hard', () => {
    const { watch, signals } = watchCapturing();
    watch.observe({ contextTokens: 160_000, contextLimit: 1_000_000 });
    watch.observe({ contextTokens: 170_000, contextLimit: 1_000_000 });
    watch.observe({ contextTokens: 199_999, contextLimit: 1_000_000 });
    expect(signals).toHaveLength(1);
    expect(signals[0].phase).toBe('soft');
  });

  it('escalates SOFT then HARD across samples', () => {
    const { watch, signals } = watchCapturing();
    watch.observe({ contextTokens: 155_000, contextLimit: 1_000_000 });
    watch.observe({ contextTokens: 205_000, contextLimit: 1_000_000 });
    expect(signals.map((s) => s.phase)).toEqual(['soft', 'hard']);
    expect(watch.reached).toBe('hard');
  });

  it('fires HARD only (skips SOFT) when the first sample is already past the hard threshold', () => {
    const { watch, signals } = watchCapturing();
    watch.observe({ contextTokens: 250_000, contextLimit: 1_000_000 });
    expect(signals).toEqual([{ phase: 'hard', contextTokens: 250_000, contextLimit: 1_000_000 }]);
    expect(watch.reached).toBe('hard');
  });

  it('does not re-fire HARD on further samples', () => {
    const { watch, signals } = watchCapturing();
    watch.observe({ contextTokens: 210_000, contextLimit: 1_000_000 });
    watch.observe({ contextTokens: 400_000, contextLimit: 1_000_000 });
    expect(signals).toHaveLength(1);
    expect(signals[0].phase).toBe('hard');
  });

  it('NEVER latches on unknown occupancy (Codex / master-review — contextTokens null)', () => {
    const onSignal = vi.fn();
    const watch = new LegRotationWatch(THRESHOLDS, onSignal);
    watch.observe({ contextTokens: null, contextLimit: null });
    watch.observe({ contextTokens: undefined });
    watch.observe({}); // no contextTokens at all
    expect(onSignal).not.toHaveBeenCalled();
    expect(watch.reached).toBe('none');
  });

  it('carries a null contextLimit through when the usage event omits it', () => {
    const { watch, signals } = watchCapturing();
    watch.observe({ contextTokens: 300_000 });
    expect(signals[0]).toEqual({ phase: 'hard', contextTokens: 300_000, contextLimit: null });
  });
});

describe('resolveRotationThresholds', () => {
  it('defaults when no env override is set', () => {
    expect(resolveRotationThresholds({})).toEqual({
      softTokens: DEFAULT_ROTATION_SOFT_TOKENS,
      hardTokens: DEFAULT_ROTATION_HARD_TOKENS,
    });
  });

  it('honours valid env overrides', () => {
    expect(
      resolveRotationThresholds({ ROTATION_SOFT_TOKENS: '90000', ROTATION_HARD_TOKENS: '140000' }),
    ).toEqual({ softTokens: 90_000, hardTokens: 140_000 });
  });

  it('falls back to defaults on non-positive / non-numeric overrides', () => {
    expect(resolveRotationThresholds({ ROTATION_SOFT_TOKENS: '-5', ROTATION_HARD_TOKENS: 'abc' })).toEqual({
      softTokens: DEFAULT_ROTATION_SOFT_TOKENS,
      hardTokens: DEFAULT_ROTATION_HARD_TOKENS,
    });
  });

  it('falls back to defaults when soft >= hard (nonsensical — soft would never fire first)', () => {
    expect(
      resolveRotationThresholds({ ROTATION_SOFT_TOKENS: '200000', ROTATION_HARD_TOKENS: '150000' }),
    ).toEqual({ softTokens: DEFAULT_ROTATION_SOFT_TOKENS, hardTokens: DEFAULT_ROTATION_HARD_TOKENS });
  });
});
