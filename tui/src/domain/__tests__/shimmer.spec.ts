import { describe, expect, it } from 'bun:test';
import {
  beaconHeat,
  shimmerCrest,
  shimmerCycleMs,
  shimmerHeat,
  WORKING_SHIMMER,
  type ShimmerSpec,
} from '../shimmer.js';

/** Round numbers, so an expectation reads as the thing being asserted rather than as arithmetic. */
const SPEC: ShimmerSpec = { speedMs: 10, crestWidth: 5, quietMs: 1000 };

describe('shimmerCycleMs', () => {
  it('is one pass across the line plus the rest that follows it', () => {
    expect(shimmerCycleMs(50, SPEC)).toBe(50 * 10 + 1000);
  });

  it('lets the rest dominate a short line — the pause is a duration, not a proportion', () => {
    // The trap this replaced: quiet measured in CELLS shrank whenever the sweep was sped up.
    expect(shimmerCycleMs(10, SPEC)).toBe(1100);
    expect(shimmerCycleMs(10, { ...SPEC, speedMs: 5 })).toBe(1050);
  });
});

describe('shimmerCrest', () => {
  it('starts at the icon and advances one cell per speedMs', () => {
    expect(shimmerCrest(0, 50, SPEC)).toBe(0);
    expect(shimmerCrest(10, 50, SPEC)).toBe(1);
    expect(shimmerCrest(250, 50, SPEC)).toBe(25);
  });

  it('runs off the end of the line during the rest, which is what makes it dark', () => {
    const crest = shimmerCrest(50 * 10 + 500, 50, SPEC);
    expect(crest).toBeGreaterThan(50);
    // Nothing on the line is lit while the crest is out there.
    expect(shimmerHeat(49, crest, SPEC)).toBe(0);
  });

  it('wraps back to the icon on the next cycle', () => {
    expect(shimmerCrest(shimmerCycleMs(50, SPEC), 50, SPEC)).toBe(0);
    expect(shimmerCrest(shimmerCycleMs(50, SPEC) + 10, 50, SPEC)).toBe(1);
  });

  it('never puts the crest behind the line, however odd the clock', () => {
    // A negative clock is not a real input, but a modulo that went negative would light nothing at
    // all — a silently dead animation is worse than a clamp.
    expect(shimmerCrest(-40, 50, SPEC)).toBeGreaterThanOrEqual(0);
  });
});

describe('shimmerHeat', () => {
  it('is full under the crest and gone a crest-width away', () => {
    expect(shimmerHeat(20, 20, SPEC)).toBe(1);
    expect(shimmerHeat(15, 20, SPEC)).toBe(0);
    expect(shimmerHeat(25, 20, SPEC)).toBe(0);
  });

  it('falls off symmetrically, so the band has no leading or trailing bias', () => {
    expect(shimmerHeat(18, 20, SPEC)).toBe(shimmerHeat(22, 20, SPEC));
  });

  it('never goes negative far from the crest', () => {
    expect(shimmerHeat(0, 40, SPEC)).toBe(0);
  });
});

describe('beaconHeat', () => {
  it('is full while the crest is still on the icon', () => {
    expect(beaconHeat(0, SPEC)).toBe(1);
  });

  it('decays over twice the crest width, so the flare outlasts the crest passing the first word', () => {
    expect(beaconHeat(5, SPEC)).toBe(0.5);
    expect(beaconHeat(10, SPEC)).toBe(0);
  });

  it('never fires again mid-cycle — the light leaves the icon, it does not come back', () => {
    // Every position after the decay is dark, including the far end of the line and the rest.
    for (const crest of [11, 25, 49, 60]) {
      expect(beaconHeat(crest, SPEC)).toBe(0);
    }
  });
});

describe('WORKING_SHIMMER', () => {
  it('rests longer than it sweeps, so a pass reads as an event rather than a strobe', () => {
    const line = 54;
    const sweep = line * WORKING_SHIMMER.speedMs;
    expect(WORKING_SHIMMER.quietMs).toBeGreaterThan(sweep);
    // ~2.5s between passes. Well clear of the spinner's 80ms, which is the point of having both.
    expect(shimmerCycleMs(line, WORKING_SHIMMER)).toBeGreaterThan(2000);
    expect(shimmerCycleMs(line, WORKING_SHIMMER)).toBeLessThan(3000);
  });
});
