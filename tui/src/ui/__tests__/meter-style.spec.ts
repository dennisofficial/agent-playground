import { afterEach, beforeEach, describe, expect, it, setSystemTime } from 'bun:test';
import { meterBand, type Meter } from '../../domain/usage.js';
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

const meter = (key: Meter['key'], label: string, utilization: number | null, resetsAt: string | null = null): Meter => ({
  label,
  key,
  window: utilization === null ? null : { utilization, resetsAt },
});

beforeEach(() => setSystemTime(NOW));
afterEach(() => setSystemTime());

describe('the fill carries the band and the track recedes', () => {
  it('tints filled and empty cells separately', () => {
    const spans = meterSpans(meter('ctx', 'ctx', 18), style, true);
    const filled = spans.find((span) => span.text.startsWith(METER_GLYPHS.fine.filled));
    const empty = spans.find((span) => span.text.startsWith(METER_GLYPHS.fine.empty));
    expect(filled?.fg).toBe(FILL_RAMPS.nearWhite.normal);
    expect(empty?.fg).toBe(style.ink.track);
  });

  it('walks the ramp as the window fills', () => {
    const colours = [18, 66, 81, 94].map((util) => bandColour(meterBand('ctx', util), style));
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

  it('says "full" for ctx, which has no reset time to promise', () => {
    // A context window is emptied by rotating, not by waiting — a clock there would be a lie.
    expect(text(meterSpans(meter('ctx', 'ctx', 100), style, true))).toBe('ctx full');
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
    expect(numberOf(meterSpans(meter('ctx', 'ctx', 81), echo, true))?.fg).toBe(FILL_RAMPS.nearWhite.hot);
  });

  it('holds the digits gray until the band is pressured', () => {
    const conditional = { ...style, ink: METER_INKS.digitsEchoWhenHot };
    expect(numberOf(meterSpans(meter('ctx', 'ctx', 18), conditional, true))?.fg).toBe(METER_INKS.digitsEchoWhenHot.quiet);
    expect(numberOf(meterSpans(meter('ctx', 'ctx', 81), conditional, true))?.fg).toBe(FILL_RAMPS.nearWhite.hot);
  });
});

describe('the strip measures what it draws', () => {
  const meters: [Meter, Meter, Meter] = [
    meter('ctx', 'ctx', 12),
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
    expect(text(stripSpans(meters, style, false))).toContain('12%');
  });

  it('keeps the digits column-aligned when slack sits inside the meter', () => {
    const inside = { ...style, separation: METER_SEPARATIONS.distance };
    const wide = stripSpans([meter('ctx', 'ctx', 99), meters[1], meters[2]], inside, true);
    const narrow = stripSpans([meter('ctx', 'ctx', 7), meters[1], meters[2]], inside, true);
    // `99%` and `7%` both occupy four columns, so the right-aligned strip stays put as they change.
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
