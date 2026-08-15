import {
  formatCountdown,
  formatPercent,
  isPressured,
  meterFill,
  type Meter,
  type MeterBand,
} from "../domain/usage.js";
import {
  RULE_FG,
  type InkSource,
  type MeterInk,
  type MeterStyle,
  type Span,
} from "./meter-style.js";

/**
 * Turning a reading into spans. Split from `meter-style.ts` so the token tables — which are edited
 * by eye, one preset at a time — do not sit in the same file as the arithmetic that consumes them.
 */

function resolve(
  source: InkSource,
  fill: string,
  ink: MeterInk,
  band: MeterBand,
): string {
  if (source === "fill") return fill;
  if (source === "fill-when-pressured")
    return isPressured(band) ? fill : ink.quiet;
  return source;
}

export function bandColour(band: MeterBand, style: MeterStyle): string {
  if (band === "unknown") return style.ink.unknown;
  if (band === "spent") return style.ramp.red;
  return style.ramp[band];
}

function spentSpans(meter: Meter, style: MeterStyle, colour: string): Span[] {
  const { label } = style.ink;
  const labelFg =
    label === "fill" || label === "fill-when-pressured" ? colour : label;

  // `ctx` never has a reset time — a context window is emptied by rotating, not by waiting — so a
  // spent one says so rather than promising a clock that will never arrive.
  const resetsAt = meter.window?.resetsAt ?? null;
  if (!resetsAt)
    return [
      { text: `${meter.label} `, fg: labelFg },
      { text: "full", fg: colour },
    ];

  const countdown = formatCountdown(resetsAt);
  const name: Span = { text: `${meter.label} `, fg: labelFg };
  switch (style.spent) {
    case "bare":
      return [name, { text: countdown, fg: colour }];
    case "verb":
      return [
        name,
        { text: "resets ", fg: labelFg },
        { text: countdown, fg: colour },
      ];
    case "clock":
      return [name, { text: `${style.glyphs.clock} ${countdown}`, fg: colour }];
    case "full":
      return [
        name,
        { text: "full", fg: colour },
        { text: " · ", fg: RULE_FG },
        { text: countdown, fg: colour },
      ];
    case "arrow":
      return [
        name,
        { text: "→ ", fg: labelFg },
        { text: countdown, fg: colour },
      ];
    case "fused":
      return [{ text: `${meter.label}·${countdown}`, fg: colour }];
  }
}

export function meterSpans(
  meter: Meter,
  style: MeterStyle,
  showBar: boolean,
): Span[] {
  const utilization = meter.window?.utilization ?? null;
  const { band } = meter;
  const colour = bandColour(band, style);

  if (band === "spent") return spentSpans(meter, style, colour);

  // The bar is always the fill; the digits are whatever the meter came to say. `ctx` prints tokens,
  // which is why the two can disagree — a green bar under an orange `210K` is the honest picture of
  // a session with plenty of window left that is nonetheless expensive to keep re-sending.
  const digits = meter.digits ?? formatPercent(utilization);
  const slack = " ".repeat(Math.max(0, 4 - digits.length));
  const filled = meterFill(utilization, style.glyphs.cells);

  const spans: Span[] = [
    {
      text: `${meter.label} `,
      fg: resolve(style.ink.label, colour, style.ink, band),
    },
  ];
  if (showBar) {
    spans.push({ text: style.glyphs.filled.repeat(filled), fg: colour });
    spans.push({
      text: style.glyphs.empty.repeat(style.glyphs.cells - filled),
      fg: style.ink.track,
    });
    spans.push({ text: " " });
  }
  if (style.separation.slack === "inside") spans.push({ text: slack });
  spans.push({
    text: digits,
    fg: resolve(style.ink.number, colour, style.ink, band),
  });
  if (style.separation.slack === "outside") spans.unshift({ text: slack });
  return spans;
}

/**
 * The whole `ctx  5h wk` strip, ready to render or measure.
 *
 * Always BARLESS. This is the composer footer's function and nothing else's — the accounts page
 * calls `meterSpans` per column so it can pad each one to a table width — so rather than thread a
 * `showBar` nobody passes true for, the one caller that draws gauges keeps the flag and this one
 * states the fact.
 *
 * The list is variable-length because shedding a meter is how the footer narrows: `ctx` leads, the
 * divider follows it, and whatever account windows are left share the gap. One meter draws no
 * divider — there is nothing on the other side of it to separate.
 */
export function stripSpans(meters: readonly Meter[], style: MeterStyle): Span[] {
  const { divider, gap, marginRight } = style.separation;
  const [first, ...rest] = meters;
  if (!first) return [];

  const spans: Span[] = [...meterSpans(first, style, false)];
  if (rest.length > 0) {
    spans.push({ text: " ".repeat(divider.pad[0]) });
    if (divider.rule) {
      spans.push({ text: divider.rule, fg: RULE_FG });
      spans.push({ text: " ".repeat(divider.pad[1]) });
    }
    for (const [index, meter] of rest.entries()) {
      if (index > 0) spans.push({ text: " ".repeat(gap) });
      spans.push(...meterSpans(meter, style, false));
    }
  }
  if (marginRight > 0) spans.push({ text: " ".repeat(marginRight) });
  return spans;
}

/** Columns a span run occupies. Code points, not UTF-16 units — the glyphs are astral-adjacent. */
export function spansWidth(spans: Span[]): number {
  return spans.reduce((total, span) => total + [...span.text].length, 0);
}
