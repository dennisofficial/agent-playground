import { describe, expect, it } from "bun:test";
import { ECourtToken, EPaletteToken } from "../../domain/settings.js";
import { ACCENT, CODE_BLUE, theme } from "../palette.js";
import { glyph, SPINNER_FRAMES, spinnerFrame } from "../glyphs.js";
import {
  ALT,
  formatElapsed,
  formatTokens,
  TRANSCRIPT_INSET,
  TRANSCRIPT_PADDING,
  theme as themeViaBarrel,
} from "../theme.js";

/**
 * The palette is about to become user-editable, which turns every one of these from an observation
 * about the current file into a contract. Two things are being pinned:
 *
 * 1. Every token is a colour the renderer can actually take — a `#rrggbb` or an ANSI name. A
 *    malformed token is invisible until the frame it fails to paint.
 * 2. The ALIASES. `theme.ts` spends ~60 lines arguing that `accent === caretBg === codeInline ===
 *    court.agent` and `code === link` are one decision each rather than four and two. Those
 *    comments are the only thing holding the invariants today, and a comment cannot fail CI.
 */

/** Every ANSI name the palette is allowed to reach for. Anything else is a typo, not a choice. */
const ANSI_NAMES = new Set([
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "gray",
]);

const HEX = /^#[0-9a-f]{6}$/;

function isColour(value: string): boolean {
  return HEX.test(value) || ANSI_NAMES.has(value);
}

/** Flatten the palette to `path -> value`, so `court` is checked as thoroughly as the top level. */
function leaves(): ReadonlyArray<readonly [string, string]> {
  const out: Array<readonly [string, string]> = [];
  for (const [key, value] of Object.entries(theme)) {
    if (typeof value === "string") {
      out.push([key, value]);
      continue;
    }
    for (const [nested, nestedValue] of Object.entries(value)) {
      out.push([`${key}.${nested}`, nestedValue]);
    }
  }
  return out;
}

describe("palette", () => {
  it("every token is a hex or a known ANSI name", () => {
    const bad = leaves().filter(([, value]) => !isColour(value));
    expect(bad).toEqual([]);
  });

  it("covers the tokens the app draws with", () => {
    // Not the full set — the ones whose ABSENCE would be a silent regression, because a component
    // reading an undefined token renders with the terminal default rather than throwing.
    const names = new Set(leaves().map(([path]) => path));
    for (const required of [
      "accent",
      "dim",
      "rule",
      "meta",
      "hover",
      "hoverBg",
      "error",
      "warn",
      "ok",
      "okBright",
      "userBg",
      "userFg",
      "harnessBg",
      "harnessFg",
      "caretBg",
      "caretFg",
      "overlayBg",
      "code",
      "link",
      "codeInline",
      "court.agent",
      "court.yours",
      "court.external",
      "court.none",
    ]) {
      expect(names).toContain(required);
    }
  });

  it("holds the one-accent rule", () => {
    // Four tokens, one decision. See the `caretBg`, `codeInline` and `court` comments in palette.ts.
    expect(theme.caretBg).toBe(ACCENT);
    expect(theme.codeInline).toBe(ACCENT);
    expect(theme.court.agent).toBe(ACCENT);
    expect(theme.accent).toBe(ACCENT);
  });

  it("holds the one-blue rule", () => {
    // A fenced identifier and a URL are the same kind of thing; an underline is what separates them.
    expect(theme.code).toBe(CODE_BLUE);
    expect(theme.link).toBe(CODE_BLUE);
  });

  it("orders the neutral ramp rule < dim < meta < hover", () => {
    // The rungs are only useful if they stay in order — `meta` sinking below `dim` is what made the
    // old header one flat grey run. `dim` is an ANSI name with no value here, so only the three
    // hexes can be compared; they must ascend.
    const lightness = (hex: string): number => {
      const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
      return 0.299 * (r ?? 0) + 0.587 * (g ?? 0) + 0.114 * (b ?? 0);
    };
    expect(lightness(theme.rule)).toBeLessThan(lightness(theme.meta));
    expect(lightness(theme.meta)).toBeLessThan(lightness(theme.hover));
  });
});

describe("the palette and the settings vocabulary agree", () => {
  // `domain/` imports nothing, so it cannot read the palette to find out what a token is called —
  // it declares the names and `ui/palette.ts` supplies the values. That split is only safe while
  // the two lists are identical, and nothing but this test makes them so. Without it, adding a
  // colour to the palette would compile, render, and quietly be unthemeable: the editor would not
  // offer it and a settings file naming it would have the key dropped on load.
  const flat = Object.entries(theme)
    .filter(([, value]) => typeof value === "string")
    .map(([key]) => key)
    .sort();

  it("names every flat palette token, and no token the palette lacks", () => {
    const tokens: string[] = Object.values(EPaletteToken);
    expect(tokens.sort()).toEqual(flat);
  });

  it("names every court", () => {
    const courts: string[] = Object.values(ECourtToken);
    expect(courts.sort()).toEqual(Object.keys(theme.court).sort());
  });

  it("has a court group and nothing else nested, which is what the codec assumes", () => {
    // `parsePalette` special-cases exactly one nested key. A second group would be silently dropped.
    const nested = Object.entries(theme)
      .filter(([, value]) => typeof value !== "string")
      .map(([key]) => key);
    expect(nested).toEqual(["court"]);
  });
});

describe("theme.ts after the split", () => {
  it("still re-exports the palette, so the 60 call sites do not churn", () => {
    expect(themeViaBarrel).toBe(theme);
  });

  it("keeps the things that are not a theme", () => {
    // Layout maths and formatters travel with the app, not with the palette — swapping a theme must
    // not be able to swap `formatTokens`.
    expect(TRANSCRIPT_INSET).toBe(1 + TRANSCRIPT_PADDING);
    expect(["opt", "alt"]).toContain(ALT);
    expect(formatElapsed(4_000)).toBe("4s");
    expect(formatElapsed(245_000)).toBe("4m 5s");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_200)).toBe("1.2k");
  });
});

describe("glyphs", () => {
  it("carries the message grammar", () => {
    for (const required of ["user", "block", "result", "thinking"] as const) {
      expect(glyph[required].length).toBeGreaterThan(0);
    }
  });

  it("advances the spinner off the wall clock, not off a render", () => {
    // Two clocks drive the working line at different rates; off the wall clock they agree.
    const first = spinnerFrame(0);
    // `some` rather than `toContain`: SPINNER_FRAMES is `as const`, so its element type is the
    // union of the ten literals and a plain `string` will not match the overload.
    expect(SPINNER_FRAMES.some((frame) => frame === first)).toBe(true);
    expect(spinnerFrame(0)).toBe(first);
    expect(spinnerFrame(80)).not.toBe(first);
  });
});
