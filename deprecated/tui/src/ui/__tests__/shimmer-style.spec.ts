import { describe, expect, it } from 'bun:test';
import { WORKING_SHIMMER, type ShimmerSpec } from '../../domain/shimmer.js';
import {
  beaconColour,
  mixHex,
  SHIMMER_CREST,
  SHIMMER_REST,
  shimmerColour,
  shimmerSpans,
} from '../shimmer-style.js';
import { theme } from '../theme.js';

const SPEC: ShimmerSpec = { speedMs: 10, crestWidth: 5, quietMs: 1000 };

describe('mixHex', () => {
  it('returns the ends of the range untouched', () => {
    expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mixHex('#000000', '#ffffff', 1)).toBe('#ffffff');
  });

  it('blends per channel and pads single digits back to two', () => {
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mixHex('#000000', '#101010', 0.5)).toBe('#080808');
  });

  it('clamps rather than wrapping, so an out-of-range heat cannot invert the ramp', () => {
    expect(mixHex('#000000', '#ffffff', 2)).toBe('#ffffff');
    expect(mixHex('#000000', '#ffffff', -1)).toBe('#000000');
  });
});

describe('shimmerColour', () => {
  it('sits at rest with no light on it', () => {
    expect(shimmerColour(0)).toBe(SHIMMER_REST);
  });

  it('reaches the crest colour at full heat', () => {
    expect(shimmerColour(1)).toBe(SHIMMER_CREST);
  });

  it('bends through the accent rather than fading straight to white', () => {
    // Every intermediate colour should be one Atlas already uses; the hinge is exactly the accent.
    expect(shimmerColour(0.6)).toBe(theme.accent);
  });
});

describe('beaconColour', () => {
  it('floors at the accent — a spinner that greys out reads as stalled', () => {
    expect(beaconColour(0)).toBe(theme.accent);
    expect(beaconColour(1)).toBe(SHIMMER_CREST);
  });
});

describe('shimmerSpans', () => {
  it('preserves the text exactly', () => {
    const text = 'Working for 53s (↓ 38.5k tokens · esc to interrupt)';
    const spans = shimmerSpans(text, 12, SPEC);
    expect(spans.map((span) => span.text).join('')).toBe(text);
  });

  it('coalesces runs of equal colour instead of emitting one span per character', () => {
    const text = 'x'.repeat(60);
    const spans = shimmerSpans(text, 30, SPEC);
    // Only the ~9 lit cells vary; everything either side is one flat run.
    expect(spans.length).toBeLessThan(15);
  });

  it('collapses to a single resting span while the crest is off the line', () => {
    const spans = shimmerSpans('x'.repeat(20), 60, SPEC);
    expect(spans).toEqual([{ text: 'x'.repeat(20), fg: SHIMMER_REST }]);
  });

  it('lights the character under the crest brightest', () => {
    const spans = shimmerSpans('abcdefghij', 5, SPEC);
    const lit = spans.find((span) => span.text === 'f');
    expect(lit?.fg).toBe(SHIMMER_CREST);
  });

  it('measures in columns, not UTF-16 units, so the crest stays in step with the screen', () => {
    // `↓` and `·` are one column each. Counting units would drift the crest right of what is drawn.
    const spans = shimmerSpans('↓·↓·↓', 0, SPEC);
    expect(spans.map((span) => span.text).join('')).toBe('↓·↓·↓');
    expect(spans[0]?.text).toBe('↓');
    expect(spans[0]?.fg).toBe(SHIMMER_CREST);
  });

  it('shifts the whole line right by the offset the icon holds', () => {
    // With the text starting at column 2, a crest at 2 lights the FIRST character, not the third.
    const spans = shimmerSpans('abcdefghij', 2, SPEC, 2);
    expect(spans[0]?.text).toBe('a');
    expect(spans[0]?.fg).toBe(SHIMMER_CREST);
  });

  it('never leaves the real line fully dark at the moment a sweep begins', () => {
    const spans = shimmerSpans('Working for 53s', 0, WORKING_SHIMMER, 2);
    expect(spans.some((span) => span.fg !== SHIMMER_REST)).toBe(true);
  });
});
