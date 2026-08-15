import { type Colour, parseColour } from "./colour.js";

/**
 * Everything Atlas remembers about how it should look, and the codec for the file it lives in.
 *
 * This is the FIRST user-level config in the app — there was no settings surface before it, only
 * two per-account toggles in SQLite and one env var. So there is nothing to migrate and no
 * backwards compatibility to keep, and the shape below is free to be exactly what it needs to be.
 *
 * Modelled on `domain/claim.ts`: a pure codec here, a thin service in `app/` that owns the file.
 * The parse is deliberately TOLERANT in the same way and for a sharper reason. A claim file is only
 * ever written by Atlas; this one is meant to be opened in an editor, which is the argument that
 * won it over a SQLite table — and anything a human can edit, a human can break. A malformed theme
 * must cost one session of default colours, never a frame that cannot paint.
 *
 * The tolerance is per-KEY, not per-file: one bad token does not discard the twenty good ones,
 * because whole-file rejection would silently revert every other preference and give the user no
 * way to tell which line did it.
 */

/**
 * The colour tokens a theme may set.
 *
 * Lives in `domain/` rather than beside the palette because `domain/` imports nothing and is the
 * layer allowed to declare vocabulary — `ui/palette.ts` supplies the VALUES, this names them. The
 * two are pinned together by a test; adding a token to the palette without adding it here would
 * quietly make that token unthemeable.
 */
export enum EPaletteToken {
  accent = "accent",
  dim = "dim",
  hover = "hover",
  rule = "rule",
  meta = "meta",
  hoverBg = "hoverBg",
  error = "error",
  warn = "warn",
  ok = "ok",
  okBright = "okBright",
  userBg = "userBg",
  userFg = "userFg",
  harnessBg = "harnessBg",
  harnessFg = "harnessFg",
  caretBg = "caretBg",
  caretFg = "caretFg",
  overlayBg = "overlayBg",
  code = "code",
  link = "link",
  codeInline = "codeInline",
}

/** The three courts plus history. Set as a group or not at all — see `parsePalette`. */
export enum ECourtToken {
  agent = "agent",
  yours = "yours",
  external = "external",
  none = "none",
}

export type CourtColours = Record<ECourtToken, Colour>;

/** Sparse: only what the user changed, so the shipped palette stays the source of everything else. */
export type PaletteOverrides = {
  [K in EPaletteToken]?: Colour;
} & {
  court?: CourtColours;
};

export type Settings = {
  /**
   * Name of the syntax-highlighting theme.
   *
   * A plain string, NOT validated against the registry here. `resolveCodeTheme` already narrows an
   * unknown name to the default without throwing, and validating twice would mean a theme removed
   * from a later build silently erases the user's choice instead of ignoring it for one release.
   */
  codeTheme: string;
  palette: PaletteOverrides;
};

export const DEFAULT_SETTINGS: Settings = {
  codeTheme: "github-dark",
  palette: {},
};

const PALETTE_TOKENS: ReadonlySet<string> = new Set<string>(Object.values(EPaletteToken));

/** Narrowing for a key out of a parsed file, so the assignment below needs no cast. */
export function isPaletteToken(key: string): key is EPaletteToken {
  return PALETTE_TOKENS.has(key);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  // `typeof null === "object"`, and an array is an object too — neither is a settings map.
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function colourAt(record: Record<string, unknown>, key: string): Colour | null {
  const raw = record[key];
  return typeof raw === "string" ? parseColour(raw) : null;
}

function parseCourt(value: unknown): CourtColours | null {
  const record = asRecord(value);
  if (!record) return null;

  const agent = colourAt(record, ECourtToken.agent);
  const yours = colourAt(record, ECourtToken.yours);
  const external = colourAt(record, ECourtToken.external);
  const none = colourAt(record, ECourtToken.none);

  // All four or nothing, and spelled out rather than accumulated so the return needs no cast to
  // claim completeness. Half a court would leave two hues from the stored theme and two from
  // whatever the palette happens to be — a scheme nobody chose, and one the list pages would read
  // as carrying meaning.
  if (!agent || !yours || !external || !none) return null;
  return { agent, yours, external, none };
}

function parsePalette(value: unknown): PaletteOverrides {
  const record = asRecord(value);
  if (!record) return {};

  const palette: PaletteOverrides = {};
  for (const [key, raw] of Object.entries(record)) {
    if (key === "court") {
      const court = parseCourt(raw);
      if (court) palette.court = court;
      continue;
    }
    // An unknown key is a token from another build, or a typo. Dropping it rather than writing it
    // through keeps the palette object free of keys nothing reads and nothing can remove.
    if (!isPaletteToken(key)) continue;
    const colour = colourAt(record, key);
    if (colour) palette[key] = colour;
  }
  return palette;
}

/**
 * A settings file to settings. Never throws, never returns a partial object.
 *
 * Unrecognised top-level keys are ignored rather than preserved: an older build reading a newer
 * file should run, and re-writing the file will drop what it did not understand — which is the
 * honest behaviour, since keeping a key it cannot show would make the editor claim a setting it
 * has no control over.
 */
export function parseSettings(raw: string): Settings {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return DEFAULT_SETTINGS;
  }

  const record = asRecord(value);
  if (!record) return DEFAULT_SETTINGS;

  return {
    codeTheme:
      typeof record["codeTheme"] === "string"
        ? record["codeTheme"]
        : DEFAULT_SETTINGS.codeTheme,
    palette: parsePalette(record["palette"]),
  };
}

/** Indented and newline-terminated, because the point of a file over a table was that a human reads it. */
export function serialiseSettings(settings: Settings): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}
