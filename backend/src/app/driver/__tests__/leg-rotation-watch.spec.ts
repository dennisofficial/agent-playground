import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ROTATION_REMINDER_DELTA_TOKENS,
  DEFAULT_ROTATION_SOFT_TOKENS,
  LegRotationWatch,
  resolveRotationThresholds,
  type LegRotationSignal,
} from '../leg-rotation-watch';

const THRESHOLDS = { softTokens: 150_000, reminderDeltaTokens: 25_000 };

function watchCapturing(): {
  watch: LegRotationWatch;
  signals: LegRotationSignal[];
} {
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
    expect(signals).toEqual([
      {
        phase: 'soft',
        reminderIndex: 0,
        contextTokens: 150_000,
        contextLimit: 1_000_000,
      },
    ]);
    expect(watch.softReached).toBe(true);
  });

  it('does not re-fire while staying inside the soft band (below soft + delta)', () => {
    const { watch, signals } = watchCapturing();
    watch.observe({ contextTokens: 155_000, contextLimit: 1_000_000 });
    watch.observe({ contextTokens: 165_000, contextLimit: 1_000_000 });
    watch.observe({ contextTokens: 174_999, contextLimit: 1_000_000 });
    expect(signals).toHaveLength(1);
    expect(signals[0].phase).toBe('soft');
  });

  it('fires SOFT then a REMINDER on each further +delta of growth', () => {
    const { watch, signals } = watchCapturing();
    watch.observe({ contextTokens: 155_000, contextLimit: 1_000_000 }); // soft
    watch.observe({ contextTokens: 180_000, contextLimit: 1_000_000 }); // +delta → reminder 1
    watch.observe({ contextTokens: 210_000, contextLimit: 1_000_000 }); // +2delta → reminder 2
    expect(signals.map((s) => ({ phase: s.phase, reminderIndex: s.reminderIndex }))).toEqual([
      { phase: 'soft', reminderIndex: 0 },
      { phase: 'reminder', reminderIndex: 1 },
      { phase: 'reminder', reminderIndex: 2 },
    ]);
  });

  it('first-ever fire is SOFT even when the first sample is already several deltas past soft', () => {
    const { watch, signals } = watchCapturing();
    watch.observe({ contextTokens: 250_000, contextLimit: 1_000_000 }); // level 4, but first → soft
    expect(signals).toEqual([
      {
        phase: 'soft',
        reminderIndex: 0,
        contextTokens: 250_000,
        contextLimit: 1_000_000,
      },
    ]);
    watch.observe({ contextTokens: 280_000, contextLimit: 1_000_000 }); // level 5 → reminder 5
    expect(signals[1]).toMatchObject({ phase: 'reminder', reminderIndex: 5 });
  });

  it('does not re-fire the same reminder band on further samples within it', () => {
    const { watch, signals } = watchCapturing();
    watch.observe({ contextTokens: 155_000, contextLimit: 1_000_000 }); // soft
    watch.observe({ contextTokens: 180_000, contextLimit: 1_000_000 }); // reminder 1
    watch.observe({ contextTokens: 190_000, contextLimit: 1_000_000 }); // still band 1 → no fire
    expect(signals).toHaveLength(2);
  });

  it('NEVER latches on unknown occupancy (Codex / master-review — contextTokens null)', () => {
    const onSignal = vi.fn();
    const watch = new LegRotationWatch(THRESHOLDS, onSignal);
    watch.observe({ contextTokens: null, contextLimit: null });
    watch.observe({ contextTokens: undefined });
    watch.observe({}); // no contextTokens at all
    expect(onSignal).not.toHaveBeenCalled();
    expect(watch.softReached).toBe(false);
  });

  it('NEVER latches on a SUBAGENT frame (its own separate window — not rotatable), only the main agent', () => {
    const { watch, signals } = watchCapturing();
    watch.observe({
      contextTokens: 220_000,
      contextLimit: 1_000_000,
      parentToolUseId: 'task-1',
    });
    expect(signals).toHaveLength(0);
    expect(watch.softReached).toBe(false);
    watch.observe({ contextTokens: 160_000, contextLimit: 1_000_000 });
    expect(signals).toEqual([
      {
        phase: 'soft',
        reminderIndex: 0,
        contextTokens: 160_000,
        contextLimit: 1_000_000,
      },
    ]);
  });

  it('carries a null contextLimit through when the usage event omits it', () => {
    const { watch, signals } = watchCapturing();
    watch.observe({ contextTokens: 300_000 });
    expect(signals[0]).toEqual({
      phase: 'soft',
      reminderIndex: 0,
      contextTokens: 300_000,
      contextLimit: null,
    });
  });
});

describe('resolveRotationThresholds', () => {
  it('returns the declared JIT-rule catalog defaults (no env override — removed by d4)', () => {
    expect(resolveRotationThresholds()).toEqual({
      softTokens: DEFAULT_ROTATION_SOFT_TOKENS,
      reminderDeltaTokens: DEFAULT_ROTATION_REMINDER_DELTA_TOKENS,
    });
  });
});
