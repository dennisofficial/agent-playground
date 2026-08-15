/**
 * The characters the transcript is built from, and the spinner that runs beside them.
 *
 * Split out of `theme.ts` with the palette because these are themeable for a reason the colours are
 * not: a glyph can be simply ABSENT. A terminal without the geometric set draws `▣` as a replacement
 * box, and a font without `⏺` turns the whole message grammar into tofu — so a user needs a way out
 * that has nothing to do with taste. Colours are a preference; these are a compatibility escape.
 */

/** The message grammar. Four glyphs carry the whole transcript. */
export const glyph = {
  user: "❯",
  block: "⏺",
  result: "⎿",
  thinking: "✻",
  queued: "⤷",
  /** Account swap — a dim inline note, deliberately NOT a seam. */
  swap: "⤿",
  selected: "❯",
  active: "⏺",
  available: "○",
  /**
   * Read state, and ONLY read state. Filled means there is something here you have not seen; the
   * middle dot means you have. The spinner used to take this cell, which made a row unable to say
   * "working" and "you owe me a keypress" at once — it lives in the status column now.
   */
  unseen: "●",
  seen: "·",
  warning: "⚠",
  failed: "✗",
  /**
   * A picture that went with a message. The terminal cannot draw it; this says it exists.
   *
   * Geometric rather than the obvious emoji: every emoji in a terminal is double-width, and a cell
   * count that is right on one terminal and wrong on the next drags the whole row out of alignment.
   */
  image: "▣",
  /** The one clickable thing in the transcript: a block's copy button. */
  copy: "⧉",
  /** Send the failed turn's prompt again — the error block's button. */
  retry: "↻",
  /** The live tail's cursor — sits at the end of the text it is writing, never on its own line. */
  caret: "▌",
} as const;

export const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;

/** How long the spinner holds a frame. Its own rhythm, deliberately not the shimmer's. */
export const SPINNER_FRAME_MS = 80;

/**
 * The spinner's frame for an instant, rather than for a tick.
 *
 * Two clocks drive the working line at different rates — the page's, and the line's own, faster one
 * for the sweep — and a spinner that advanced per RENDER would run at whichever rate happened to be
 * driving it. Off the wall clock, both agree.
 */
export function spinnerFrame(nowMs: number): string {
  const index = Math.floor(nowMs / SPINNER_FRAME_MS) % SPINNER_FRAMES.length;
  return SPINNER_FRAMES[index] as string;
}
