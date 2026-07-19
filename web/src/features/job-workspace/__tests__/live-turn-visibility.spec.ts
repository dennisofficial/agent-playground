import { describe, expect, it } from 'vitest';
import { liveTurnVisibleForLeg } from '../lib/live-turn-visibility';

describe('liveTurnVisibleForLeg', () => {
  it('shows the live turn on a non-Leg lane (legOrdinal undefined), regardless of legIsLive', () => {
    expect(liveTurnVisibleForLeg(undefined, undefined)).toBe(true);
    expect(liveTurnVisibleForLeg(undefined, false)).toBe(true);
    expect(liveTurnVisibleForLeg(undefined, true)).toBe(true);
  });

  it('shows the live turn on the active/live Leg', () => {
    expect(liveTurnVisibleForLeg(3, true)).toBe(true);
  });

  it('hides the live turn on a rotated/closed Leg', () => {
    expect(liveTurnVisibleForLeg(1, false)).toBe(false);
    expect(liveTurnVisibleForLeg(2, false)).toBe(false);
  });

  it('hides the live turn on a Leg with unknown live status (safe default)', () => {
    expect(liveTurnVisibleForLeg(1, undefined)).toBe(false);
  });
});
