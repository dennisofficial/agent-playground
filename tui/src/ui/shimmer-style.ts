import {
  shimmerHeat,
  type ShimmerSpec,
} from "../domain/shimmer.js";
import type { Span } from "./meter-style.js";
import { theme } from "./theme.js";

/**
 * Heat → colour, and a line → spans. Split from `domain/shimmer.ts` the way `meter-spans` is split
 * from `meter-style`: the arithmetic is testable without a palette, and the palette is edited by eye.
 */

/**
 * The line at rest. `theme.dim` is the terminal's own `gray`, which is a name rather than a value
 * and so cannot be interpolated — a fade needs a real hex to fade FROM.
 *
 * ABOVE dim, deliberately, and that is the whole point of the value. This was `#6d6862` — rgb(109,
 * 104, 98) — while ANSI `gray` sits near rgb(128, 128, 128) in most palettes, so a turn that was
 * actively running rendered DARKER than the finished transcript above it. The duty cycle made it
 * worse: at `WORKING_SHIMMER`'s 18ms/cell and 1500ms rest, a ~50-cell label spends roughly 60% of
 * every cycle sitting at exactly this colour, so this — not the crest — is what "working" mostly
 * looks like. It read as a line that had stalled.
 *
 * It sits BETWEEN `theme.meta` and `theme.hover` on the neutral ramp, and is deliberately not either
 * of them: `meta` is level with `dim` once you measure it, so it would not have fixed anything, and
 * `hover` is bright enough to compete with the crest this ramp is supposed to travel towards. Like
 * `SHIMMER_CREST` below, it is therefore off-palette on purpose — worth knowing before a theme
 * editor tries to claim every hex in the app.
 */
export const SHIMMER_REST = "#9c948c";

/** The top of the crest. Warm near-white — the accent with the lights turned up, not a second hue. */
export const SHIMMER_CREST = "#ffd9c4";

function channels(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/** Linear blend of two `#rrggbb` strings. `t` outside 0..1 is clamped, not wrapped. */
export function mixHex(from: string, to: string, t: number): string {
  const amount = Math.max(0, Math.min(1, t));
  const [fr, fg, fb] = channels(from);
  const [tr, tg, tb] = channels(to);
  const channel = (a: number, b: number): string =>
    Math.round(a + (b - a) * amount)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(fr, tr)}${channel(fg, tg)}${channel(fb, tb)}`;
}

/**
 * Two ramps, not one: rest → accent for the leading edge, accent → near-white for the last of it.
 *
 * A single rest → white ramp spends most of its travel in washed-out pinks that belong to no part of
 * the palette. Bending it through the accent keeps every intermediate colour a colour Atlas already
 * uses, and puts the brightest 40% of the range in the few cells that are actually at the crest.
 */
export function shimmerColour(heat: number): string {
  if (heat > 0.6) return mixHex(theme.accent, SHIMMER_CREST, (heat - 0.6) / 0.4);
  return mixHex(SHIMMER_REST, theme.accent, heat / 0.6);
}

/**
 * The icon's ramp, floored at the accent rather than at rest.
 *
 * A spinner that fades to grey between sweeps reads as stalled, which is the one thing this line
 * must never say by accident — it is on screen precisely because the turn is alive.
 */
export function beaconColour(heat: number): string {
  return mixHex(theme.accent, SHIMMER_CREST, heat);
}

/**
 * The line, lit.
 *
 * Runs of equal colour are coalesced. With a six-cell crest, all but ~13 columns of a line sit at
 * rest, so this is the difference between three or four spans per frame and one per character — at
 * 25 frames a second, on a line that lives for the length of a turn.
 */
export function shimmerSpans(
  text: string,
  crest: number,
  spec: ShimmerSpec,
  /** Column the text starts at. The icon holds column 0, so the first character is at 1. */
  offset = 0,
): Span[] {
  const spans: Span[] = [];
  // Code points, not UTF-16 units: `↓` and `·` are one column each and must count as one cell, or
  // the crest drifts out of step with what is on screen.
  const characters = [...text];

  for (const [index, character] of characters.entries()) {
    const fg = shimmerColour(shimmerHeat(index + offset, crest, spec));
    const last = spans[spans.length - 1];
    if (last && last.fg === fg) {
      last.text += character;
      continue;
    }
    spans.push({ text: character, fg });
  }
  return spans;
}
