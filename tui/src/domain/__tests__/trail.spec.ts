import { describe, expect, it } from 'bun:test';
import { fitTrail, joinTrail } from '../trail.js';

const TRAIL = ['atlas', 'fix steering', 'builder'];

describe('fitTrail', () => {
  it('keeps the whole trail when it fits', () => {
    expect(fitTrail(TRAIL, 80)).toBe(joinTrail(TRAIL));
  });

  it('drops from the FRONT — the specific end is the part that says where you are', () => {
    expect(fitTrail(TRAIL, 24)).toBe('fix steering › builder');
  });

  it('drops as many leading segments as it takes', () => {
    expect(fitTrail(TRAIL, 10)).toBe('builder');
  });

  it('truncates the last segment rather than rendering nothing', () => {
    expect(fitTrail(TRAIL, 4)).toBe('bui…');
  });

  it('ignores empty segments, so an unknown one costs no separator', () => {
    expect(fitTrail(['atlas', '', 'builder'], 80)).toBe('atlas › builder');
  });

  it('is empty for an empty trail', () => {
    expect(fitTrail([], 80)).toBe('');
  });

  it('never exceeds the width it was given', () => {
    for (const width of [1, 2, 3, 7, 13, 21, 34]) {
      expect(fitTrail(TRAIL, width).length).toBeLessThanOrEqual(Math.max(width, 1));
    }
  });
});
