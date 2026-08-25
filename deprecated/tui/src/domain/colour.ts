/**
 * What a colour is allowed to be, and the one distinction the renderer cannot make for us.
 *
 * Two kinds of value reach a `fg` / `bg`, and they behave differently in a way that has already
 * cost a bug: a hex is a value we own, and an ANSI NAME is a lookup into the user's own terminal
 * palette. The names are load-bearing — `dim`, `error`, `warn` and `ok` are names precisely so a
 * light-terminal user gets their own greys and reds rather than ours — but that also means nothing
 * may interpolate through them. `mixHex` parses hex digits; hand it `"gray"` and every channel is
 * `NaN`, which paints nothing and reports nothing.
 *
 * So the split is a type rather than a comment: a function that mixes declares `Hex`, and passing
 * it a token that might be an ANSI name is a compile error instead of an invisible blank.
 */

export enum EAnsiColour {
  black = "black",
  red = "red",
  green = "green",
  yellow = "yellow",
  blue = "blue",
  magenta = "magenta",
  cyan = "cyan",
  white = "white",
  gray = "gray",
}

/** A literal `#rrggbb`, lower case. The only thing the mixing and ramp helpers accept. */
export type Hex = `#${string}`;

/** Anything that can reach a renderer's `fg` / `bg`. */
export type Colour = Hex | EAnsiColour;

const HEX_PATTERN = /^#[0-9a-f]{6}$/i;

const ANSI_NAMES: ReadonlySet<string> = new Set<string>(Object.values(EAnsiColour));

export function isHex(value: string): value is Hex {
  return HEX_PATTERN.test(value);
}

export function isAnsiColour(value: string): value is EAnsiColour {
  return ANSI_NAMES.has(value);
}

/**
 * Text from outside the type system — a hand-edited settings file, a hex typed into the editor —
 * to a colour, or `null` for "that is not one".
 *
 * Hex is lower-cased on the way in. A human types `#00FF00` and a picker emits `#00ff00`; without
 * normalising, the editor would show the same colour two ways and a round trip through the file
 * would not be idempotent.
 */
export function parseColour(value: string): Colour | null {
  // Lower-cased BEFORE the guards rather than after, so each guard narrows the value being returned
  // and neither branch needs a cast to say what it already proved.
  const lowered = value.trim().toLowerCase();
  if (isHex(lowered)) return lowered;
  if (isAnsiColour(lowered)) return lowered;
  return null;
}

/** Narrow a stored colour at a call site that has to interpolate it. */
export function isMixable(colour: Colour): colour is Hex {
  return colour.startsWith("#");
}
