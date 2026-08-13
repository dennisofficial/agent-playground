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
  /**
   * Behind a hovered, clickable region.
   *
   * A wash rather than a brighter foreground because the region is a whole BLOCK — a tool group and its
   * rows, a thinking block and its body — and recolouring every line's text would fight the dim/measure
   * distinction those lines already carry. It also has to run the full row width, or the highlight reads
   * as a selection of the words rather than of the thing a click acts on.
   */
  hoverBg: "#2b2724",
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
   * Atlas's own injected turns take a slab for the same reason the user's does — "who said this" is
   * a question the eye should answer before it reads a word, and a hand-off runs for pages, so the
   * answer has to hold for the whole block rather than sit on its first line.
   *
   * Hue is what separates the two, not weight: this is the accent's own hue taken down to slab
   * darkness, where `userBg` is a near-neutral warm grey. Same loudness, different temperature, so
   * neither speaker reads as more important than the other and the pair can never be confused for
   * one. The accent itself runs down the left edge as a rule — the job a per-line `┃` used to do one
   * character at a time, which is what kept the body a column of prefixed lines rather than a block
   * that could be laid out.
   */
  harnessBg: "#3d2318",
  harnessFg: "#f3e3d8",
  /**
   * The composer caret. Inverse video looked right in theory and isn't: it hands both colours to the
   * terminal, which on a dark theme paints a white cell under white text and swallows the character
   * the caret is sitting on. So the caret names both of its own colours — the accent behind it, the
   * slab's dark neutral in front — and the character under it stays readable.
   */
  caretBg: ACCENT,
  caretFg: "#241f1c",
  /**
   * Behind something drawn OVER the transcript rather than in it — today, the jump-to-bottom pill.
   *
   * The one dark neutral in the palette, the same one the caret paints its character on: an overlay
   * has to occlude, and occluding means naming a background, because the terminal's own is
   * transparent to whatever it was already showing. Near-black rather than a lighter surface, so the
   * float reads as a hole punched in the text rather than as a block of the text lit up — which is
   * what carries the "this is chrome" for a one-row pill that has no border to say it.
   */
  overlayBg: "#241f1c",
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
  /**
   * The second exception to the one-accent rule, and it earns one the same way the blue does: it is
   * carrying information no other channel can.
   *
   * A list row says two independent things — whether you have READ it (the dot's shape) and whose
   * court it is in (the dot's colour). One accent can only draw one of them, and collapsing them
   * into a single word was measured to merge four situations you would act on differently. So the
   * three courts get three hues, and the dot is the only place in the app they appear.
   *
   * Amber for yours because it is the one that should catch a glance across a full screen; violet
   * for external because it must read as *not your move* without reading as failure; the accent
   * itself for the agent, which is the colour a working row has always been.
   */
  court: {
    agent: ACCENT,
    yours: "#e3b341",
    external: "#b392f0",
    /** History. Nobody's court, so it takes the same weight as everything else that is over. */
    none: "gray",
  },
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
