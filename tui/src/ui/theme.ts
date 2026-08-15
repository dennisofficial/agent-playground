/**
 * What is NOT a theme, plus the barrel that keeps the rest reachable from here.
 *
 * This file used to be three things at once: the palette, the glyph set, and a handful of layout
 * constants and formatters. That made "the theme" unswappable — you could not replace the colours
 * without also replacing `formatTokens`. The colours now live in `palette.ts` and the characters in
 * `glyphs.ts`; what stayed is everything a different theme would keep unchanged.
 *
 * Both are re-exported below, because ~60 modules already import `theme` and `glyph` from here and
 * a rename would be churn without a reader. Prefer importing from `palette.js` / `glyphs.js` in new
 * code — this barrel exists for the existing call sites, not as the intended door.
 */

export { ACCENT, CODE_BLUE, theme } from "./palette.js";
export { glyph, SPINNER_FRAMES, SPINNER_FRAME_MS, spinnerFrame } from "./glyphs.js";

/**
 * What to CALL the option/alt key, which is the same key under two names.
 *
 * A Mac keyboard has no key labelled `alt`, and a PC keyboard has none labelled `opt`. A hint is
 * only a hint if it names a key the reader can find, so every binding that uses this key spells it
 * the way the machine in front of them spells it.
 *
 * Not themeable: a platform fact, not a preference. A theme that could rename this would be a theme
 * that could lie about the keyboard.
 */
export const ALT = process.platform === "darwin" ? "opt" : "alt";

/**
 * One blank column between the longest transcript line and the scrollbar track, so text does not
 * touch the bar it scrolls with. Applied as the scrollbox's content padding, so every block —
 * prose, the user's slab, a fence — stops short of the track by the same amount.
 */
export const TRANSCRIPT_PADDING = 1;

/**
 * Columns the transcript does NOT hand to a block: the vertical scrollbar's own track plus the
 * padding above. A block that has to know its width BEFORE it renders — a fence deciding whether it
 * overflows, prose choosing a wrap column — measures against the terminal, which is this much wider
 * than the space it actually gets.
 *
 * Load-bearing for wrap maths, so it stays out of the palette: a theme that could change this could
 * make every fence in the transcript overflow its container.
 */
export const TRANSCRIPT_INSET = 1 + TRANSCRIPT_PADDING;

/** `4s`, `4m 5s` — the working line's elapsed clock. */
export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

/** `1.2k` — token counts are a sense of scale, not an accounting record. */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  return `${(tokens / 1000).toFixed(1)}k`;
}
