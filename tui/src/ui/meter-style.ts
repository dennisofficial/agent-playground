import type { MeterBand } from "../domain/usage.js";

export type Span = { text: string; fg?: string };

// ─── fill ramp ────────────────────────────────────────────────────────────────────────────────
/** Four bands the eye can tell apart without reading: rest → warn → hot → red. */
export type FillRamp = Record<"normal" | "warn" | "hot" | "red", string>;

export const FILL_RAMPS = {
  /** Resting fill is bright neutral; every hue above it reads as a departure from white. */
  nearWhite: {
    normal: "#c8c8c8",
    warn: "#d7b34a",
    hot: "#e08a45",
    red: "#d95757",
  },
  /** Resting fill stays gray, so colour in the footer NEVER means "everything is fine". */
  grayRest: {
    normal: "#8f8f8f",
    warn: "#d7b34a",
    hot: "#e08a45",
    red: "#d95757",
  },
  /** Louder alarms — reads from across the room, costs more attention when it fires. */
  saturated: {
    normal: "#cfcfcf",
    warn: "#e8c33f",
    hot: "#ef8c33",
    red: "#ef5350",
  },
  /** Desaturated throughout: colour present, never shouting from a line that is always on screen. */
  muted: { normal: "#bdbdbd", warn: "#bda45a", hot: "#c58455", red: "#c46565" },
} as const satisfies Record<string, FillRamp>;

// ─── ink ──────────────────────────────────────────────────────────────────────────────────────
export type InkSource = string | "fill" | "fill-when-pressured";

export type MeterInk = {
  label: InkSource;
  number: InkSource;
  /** Empty cells. Recessed far enough that the fill is the only part with weight. */
  track: string;
  /** Stands in for `fill` while a `-when-pressured` source is still resting. */
  quiet: string;
  /** A window nobody has measured yet — dimmer than any band, because it is not a reading. */
  unknown: string;
};

const TRACK = "#343434";
const UNKNOWN = "#4f4f4f";

export const METER_INKS = {
  /** Label recedes, digits are the brightest thing on the line. */
  numberLeads: {
    label: "#5c5c5c",
    number: "#c0c0c0",
    track: TRACK,
    quiet: "#8a8a8a",
    unknown: UNKNOWN,
  },
  /** Both recede — the bar carries the meaning, the digits are there when you go looking. */
  bothRecede: {
    label: "#5c5c5c",
    number: "#5c5c5c",
    track: TRACK,
    quiet: "#8a8a8a",
    unknown: UNKNOWN,
  },
  /** One mid gray for the text, no internal hierarchy. */
  flatMid: {
    label: "#7d7d7d",
    number: "#7d7d7d",
    track: TRACK,
    quiet: "#7d7d7d",
    unknown: UNKNOWN,
  },
  /** The number takes the band colour; the label stays out of it. */
  digitsEcho: {
    label: "#5c5c5c",
    number: "fill",
    track: TRACK,
    quiet: "#8a8a8a",
    unknown: UNKNOWN,
  },
  /** The name lights up instead of the number. */
  labelEcho: {
    label: "fill",
    number: "#8a8a8a",
    track: TRACK,
    quiet: "#8a8a8a",
    unknown: UNKNOWN,
  },
  /** Gray at rest; the digits join the alarm only once the band leaves `normal`. */
  digitsEchoWhenHot: {
    label: "#5c5c5c",
    number: "fill-when-pressured",
    track: TRACK,
    quiet: "#8a8a8a",
    unknown: UNKNOWN,
  },
  /** Label, bar and number all move together — the meter reads as one object. */
  wholeMeter: {
    label: "fill",
    number: "fill",
    track: TRACK,
    quiet: "#8a8a8a",
    unknown: UNKNOWN,
  },
} as const satisfies Record<string, MeterInk>;

// ─── glyphs ───────────────────────────────────────────────────────────────────────────────────
export type MeterGlyphs = {
  filled: string;
  empty: string;
  /** Five reads as a proportion at a glance and still fits three meters at 80 columns. */
  cells: number;
  /** Drawn where the bar would be once a window is spent, if the form asks for it. */
  clock: string;
};

export const METER_GLYPHS = {
  /** Outlined parallelograms — the fill is a shape change as well as a colour change. */
  fine: { filled: "▰", empty: "▱", cells: 5, clock: "◷" },
  /** Full blocks on a shaded track: the most legible bar, and the heaviest. */
  blocks: { filled: "█", empty: "░", cells: 6, clock: "◷" },
  /** A hairline rail — the gauge stops being furniture. */
  rail: { filled: "━", empty: "─", cells: 6, clock: "◷" },
  /** Small squares on a dotted track. */
  dots: { filled: "▪", empty: "·", cells: 5, clock: "◷" },
} as const satisfies Record<string, MeterGlyphs>;

// ─── separation ───────────────────────────────────────────────────────────────────────────────
export type MeterSeparation = {
  /** Columns either side of the `ctx` / account-windows boundary, and what sits between them. */
  divider: { pad: [number, number]; rule?: string };
  /** Columns between `5h` and `wk`. */
  gap: number;
  /** Columns held clear of the composer's right edge. */
  marginRight: number;
  slack: "inside" | "outside" | "none";
};

export const METER_SEPARATIONS = {
  /** The original: a vertical rule, and the strip flush against the composer edge. */
  rule: {
    divider: { pad: [2, 2], rule: "│" },
    gap: 2,
    marginRight: 0,
    slack: "inside",
  },
  /** The rule dies; distance alone does the grouping. */
  distance: {
    divider: { pad: [5, 0] },
    gap: 2,
    marginRight: 1,
    slack: "inside",
  },
  /** All three equally spaced — one list, no groups. */
  even: { divider: { pad: [4, 0] }, gap: 4, marginRight: 1, slack: "inside" },
  /** A dim mid-dot: a joint rather than a wall. */
  dot: {
    divider: { pad: [2, 2], rule: "·" },
    gap: 3,
    marginRight: 1,
    slack: "inside",
  },
  /** Wide everywhere, and clear of the edge. */
  roomy: { divider: { pad: [6, 0] }, gap: 3, marginRight: 2, slack: "inside" },
  /** The two account windows nearly touch while `ctx` sits well clear — grouping without a glyph. */
  tightPairs: {
    divider: { pad: [7, 0] },
    gap: 1,
    marginRight: 2,
    slack: "inside",
  },
} as const satisfies Record<string, MeterSeparation>;

/** The rule glyph is furniture, so it sits below even the label. */
/** The hairline between meters, and the `·` inside a spent one. */
export const RULE_FG = "#3a3a3a";

// ─── spent ────────────────────────────────────────────────────────────────────────────────────
export type SpentForm = "bare" | "verb" | "clock" | "full" | "arrow" | "fused";

// ─── the style ────────────────────────────────────────────────────────────────────────────────
export type MeterStyle = {
  ramp: FillRamp;
  ink: MeterInk;
  glyphs: MeterGlyphs;
  separation: MeterSeparation;
  spent: SpentForm;
};

export const METER_PRESETS = {
  /** Reads as an instrument: bright resting fill, digits brightest, no rule. */
  instrument: {
    ramp: FILL_RAMPS.nearWhite,
    ink: METER_INKS.numberLeads,
    glyphs: METER_GLYPHS.fine,
    separation: METER_SEPARATIONS.distance,
    spent: "bare",
  },
  /** Ambient until something is wrong: gray at rest, and the digits only join the alarm when it fires. */
  ambient: {
    ramp: FILL_RAMPS.grayRest,
    ink: METER_INKS.digitsEchoWhenHot,
    glyphs: METER_GLYPHS.fine,
    separation: METER_SEPARATIONS.roomy,
    spent: "bare",
  },
  /** The old footer, expressed in the new vocabulary — kept as the thing to compare against. */
  legacy: {
    ramp: FILL_RAMPS.muted,
    ink: METER_INKS.flatMid,
    glyphs: METER_GLYPHS.fine,
    separation: METER_SEPARATIONS.rule,
    spent: "verb",
  },
} as const satisfies Record<string, MeterStyle>;

export const meterStyle: MeterStyle = METER_PRESETS.instrument;
