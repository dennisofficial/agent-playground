/**
 * ONE accent colour, for the active `⏺` and the selected `❯`. Red only for failure.
 *
 * Density comes from removing chrome, not from adding colour: no timestamps, no speaker rules, no
 * boxes except the composer and the overlays above it. A transcript should read like a log, not a
 * chat app.
 */
const ACCENT = "#d97757";

/** Machine text — fenced code and links. See `theme.code` for why those two share it. */
const CODE_BLUE = "#7cbdff";

export const theme = {
  accent: ACCENT,
  dim: "gray",
  hover: "#e6e0da",
  error: "red",
  warn: "yellow",
  ok: "green",
  /**
   * A confirmation that has to be read in the second it is on screen — `copied` in the composer's
   * border, and nothing slower than that.
   *
   * ANSI `green` is the terminal's own dark green, which sits at almost the same weight as the dim
   * border it is drawn into: legible if you look for it, invisible if you glance. This is the same
   * green `ok` means, taken up to where a transient message can be caught in passing.
   */
  okBright: "#7ee787",
  /**
   * The user's own turns render as a full-width slab so the eye can find "where did I last speak"
   * without reading a word. A warm neutral, one step off the accent's hue — loud enough to separate,
   * quiet enough to sit under a whole paragraph of pasted text.
   */
  userBg: "#332e2a",
  userFg: "#f0e9e3",
  /**
   * The composer caret. Inverse video looked right in theory and isn't: it hands both colours to the
   * terminal, which on a dark theme paints a white cell under white text and swallows the character
   * the caret is sitting on. So the caret names both of its own colours — the accent behind it, the
   * slab's dark neutral in front — and the character under it stays readable.
   */
  caretBg: ACCENT,
  caretFg: "#241f1c",
  /**
   * The exception to the one-accent rule, and the reason it earns one: inside rendered markdown,
   * bold and dim are already spoken for by headings and quotes, so a fenced identifier and a URL
   * have no weight left to distinguish them. One blue does both — it reads as "machine text"
   * rather than as a second accent competing with `⏺`. What separates a link from code is not hue
   * but an underline; see `markup.link` in `syntax-style.ts`.
   */
  code: CODE_BLUE,
  link: CODE_BLUE,
  /**
   * Inline code takes the ACCENT, not the blue the other two share.
   *
   * A backticked `identifier` mid-sentence is a different thing from a fenced block: it is a word
   * of the prose that happens to name something in the machine, and the transcript's job there is
   * to let the eye catch it while reading a line — not to file it with a quoted block three lines
   * down. Orange does that at a glance where a cool blue receded into the sentence.
   *
   * It does not collide with headings, which are the accent too: a heading is bold and owns its
   * line, so weight and position tell them apart everywhere they meet.
   */
  codeInline: ACCENT,
} as const;

/**
 * What to CALL the option/alt key, which is the same key under two names.
 *
 * A Mac keyboard has no key labelled `alt`, and a PC keyboard has none labelled `opt`. A hint is
 * only a hint if it names a key the reader can find, so every binding that uses this key spells it
 * the way the machine in front of them spells it.
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
 */
export const TRANSCRIPT_INSET = 1 + TRANSCRIPT_PADDING;

/** The message grammar. Four glyphs carry the whole transcript. */
export const glyph = {
  user: "❯",
  block: "⏺",
  result: "⎿",
  thinking: "✻",
  queued: "⤷",
  /** Account swap — a dim inline note, deliberately NOT a seam. */
  swap: "⤿",
  /**
   * Atlas's own voice: a rule down the left of an injected message. A rule rather than a bullet
   * because a harness message can run for pages — a hand-off does — and the eye needs to be able to
   * see where Atlas stops speaking without reading to find out.
   */
  harness: "┃",
  selected: "❯",
  active: "⏺",
  available: "○",
  warning: "⚠",
  failed: "✗",
  /** The one clickable thing in the transcript: a block's copy button. */
  copy: "⧉",
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
