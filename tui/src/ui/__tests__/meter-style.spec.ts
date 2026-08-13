import { afterEach, beforeEach, describe, expect, it, setSystemTime } from 'bun:test';
import { formatTokens } from '../../domain/context-nudge.js';
import { meterBand, type Meter, type MeterBand, type MeterKey } from '../../domain/usage.js';
import {
  FILL_RAMPS,
  METER_GLYPHS,
  METER_INKS,
  METER_PRESETS,
  METER_SEPARATIONS,
  meterStyle,
  type MeterStyle,
  type Span,
} from '../meter-style.js';
import { bandColour, meterSpans, spansWidth, stripSpans } from '../meter-spans.js';

const NOW = Date.parse('2026-08-02T20:00:00Z');
const RESETS = '2026-08-02T22:14:00Z';

const style: MeterStyle = METER_PRESETS.instrument;
const text = (spans: Span[]): string => spans.map((span) => span.text).join('');

/** An account window: its band falls out of its own fill, which is all there is to know about it. */
const meter = (key: MeterKey, label: string, utilization: number | null, resetsAt: string | null = null): Meter => ({
  label,
  band: meterBand(key, utilization),
  window: utilization === null ? null : { utilization, resetsAt },
});

/** `ctx`: tokens on the digits, window fill in the bar, budget pressure in the colour. */
const ctx = (percent: number, tokens: number, band: MeterBand = 'normal'): Meter => ({
  label: 'ctx',
  band,
  window: { utilization: percent, resetsAt: null },
  digits: formatTokens(tokens),
});

beforeEach(() => setSystemTime(NOW));
afterEach(() => setSystemTime());

describe('the fill carries the band and the track recedes', () => {
  it('tints filled and empty cells separately', () => {
    const spans = meterSpans(ctx(18, 36_000), style, true);
    const filled = spans.find((span) => span.text.startsWith(METER_GLYPHS.fine.filled));
    const empty = spans.find((span) => span.text.startsWith(METER_GLYPHS.fine.empty));
    expect(filled?.fg).toBe(FILL_RAMPS.nearWhite.normal);
    expect(empty?.fg).toBe(style.ink.track);
  });

  it('walks the ramp as the window fills', () => {
    const colours = [18, 66, 90, 95].map((util) => bandColour(meterBand('fiveHour', util), style));
    expect(colours).toEqual([
      FILL_RAMPS.nearWhite.normal,
      FILL_RAMPS.nearWhite.warn,
      FILL_RAMPS.nearWhite.hot,
      FILL_RAMPS.nearWhite.red,
    ]);
  });

  it('gives an unmeasured window its own colour rather than a band', () => {
    const spans = meterSpans(meter('fiveHour', '5h', null), style, true);
    expect(text(spans)).toContain('—');
    expect(spans.some((span) => span.fg === style.ink.unknown)).toBe(true);
  });
});

describe('a spent window stops being a quantity', () => {
  it('drops the bar and the percent for the countdown', () => {
    const spans = meterSpans(meter('fiveHour', '5h', 100, RESETS), style, true);
    expect(text(spans)).toBe('5h 2h14m');
    expect(text(spans)).not.toContain('%');
    expect(text(spans)).not.toContain(METER_GLYPHS.fine.filled);
  });

  it('never says "full" for ctx, however full the window is', () => {
    // A refilling window at 100% has no quantity left to report, which is what lets the strip drop
    // the bar for a countdown. A context window has no clock — it is emptied by rotating, not by
    // waiting — so the count stays the answer right up to the wall.
    const spans = meterSpans(ctx(100, 198_000, 'red'), style, true);
    expect(text(spans)).toContain('198K');
    expect(text(spans)).not.toContain('full');
    expect(text(spans)).toContain(METER_GLYPHS.fine.filled);
  });

  it('renders each spent form the way its name says', () => {
    const forms = (['bare', 'verb', 'clock', 'full', 'arrow', 'fused'] as const).map((spent) =>
      text(meterSpans(meter('fiveHour', '5h', 100, RESETS), { ...style, spent }, true)),
    );
    expect(forms).toEqual(['5h 2h14m', '5h resets 2h14m', '5h ◷ 2h14m', '5h full · 2h14m', '5h → 2h14m', '5h·2h14m']);
  });
});

describe('ink schemes resolve against the band', () => {
  const numberOf = (spans: Span[]): Span | undefined => spans.filter((span) => span.text.includes('%')).at(-1);

  it('echoes the fill in the digits when asked to', () => {
    const echo = { ...style, ink: METER_INKS.digitsEcho };
    expect(numberOf(meterSpans(meter('fiveHour', '5h', 90), echo, true))?.fg).toBe(FILL_RAMPS.nearWhite.hot);
  });

  it('holds the digits gray until the band is pressured', () => {
    const conditional = { ...style, ink: METER_INKS.digitsEchoWhenHot };
    expect(numberOf(meterSpans(meter('fiveHour', '5h', 18), conditional, true))?.fg).toBe(METER_INKS.digitsEchoWhenHot.quiet);
    expect(numberOf(meterSpans(meter('fiveHour', '5h', 90), conditional, true))?.fg).toBe(FILL_RAMPS.nearWhite.hot);
  });

  it('colours the ctx digits by the BAND, not by the bar they sit next to', () => {
    // The state the whole change exists for: a fifth of a million-token window used, and expensive
    // enough that Atlas is already asking for a hand-off. Green bar, orange number.
    const echo = { ...style, ink: METER_INKS.digitsEcho };
    const spans = meterSpans(ctx(20, 200_000, 'hot'), echo, true);
    expect(spans.find((span) => span.text === '200K')?.fg).toBe(FILL_RAMPS.nearWhite.hot);
  });
});

describe('the strip measures what it draws', () => {
  const meters: [Meter, Meter, Meter] = [
    ctx(12, 24_000),
    meter('fiveHour', '5h', 34, RESETS),
    meter('sevenDay', 'wk', 61, RESETS),
  ];

  it('reports the width of the rendered spans, not of a parallel string', () => {
    // Measuring one representation and drawing another is how this line silently wrapped before.
    const spans = stripSpans(meters, style, true);
    expect(spansWidth(spans)).toBe([...text(spans)].length);
  });

  it('sheds the gauges before it sheds a number', () => {
    const withBars = spansWidth(stripSpans(meters, style, true));
    const without = spansWidth(stripSpans(meters, style, false));
    expect(withBars - without).toBe(3 * (METER_GLYPHS.fine.cells + 1));
    expect(text(stripSpans(meters, style, false))).toContain('24K');
  });

  it('keeps the digits column-aligned when slack sits inside the meter', () => {
    const inside = { ...style, separation: METER_SEPARATIONS.distance };
    const wide = stripSpans([ctx(99, 178_000), meters[1], meters[2]], inside, true);
    const narrow = stripSpans([ctx(4, 7_000), meters[1], meters[2]], inside, true);
    // `178K` and `7K` both occupy four columns, so the right-aligned strip stays put as they change.
    expect(spansWidth(wide)).toBe(spansWidth(narrow));
  });

  it('does shrink when a window goes spent — the bar and the percent are gone', () => {
    // The one width change padding cannot absorb, and the reason it is worth knowing about: the
    // neighbours slide the moment a window walls. `5h ▰▰▱▱▱  34%` → `5h 2h14m`.
    const live = spansWidth(stripSpans(meters, style, true));
    const spent = spansWidth(stripSpans([meters[0], meter('fiveHour', '5h', 100, RESETS), meters[2]], style, true));
    expect(live - spent).toBe(5);
  });

  it('costs the same across every separation except the margin and the rule', () => {
    const ruled = spansWidth(stripSpans(meters, { ...style, separation: METER_SEPARATIONS.rule }, true));
    const roomy = spansWidth(stripSpans(meters, { ...style, separation: METER_SEPARATIONS.roomy }, true));
    expect(roomy).toBeGreaterThan(ruled);
  });
});

describe('the active style is a preset', () => {
  it('so a change is one line and the preview shows what ships', () => {
    const presets: MeterStyle[] = Object.values(METER_PRESETS);
    expect(presets).toContain(meterStyle);
  });
});
