import { onPaletteChange } from "../../palette-store.js";
import type { CodeTheme } from "./code-theme.js";
import { buildAtlasCode } from "./atlas.js";
import { githubDark } from "./github-dark.js";

export type {
  CodeRole,
  CodeTheme,
  DiffPalette,
  DiffRowPalette,
  DiffRowStyle,
} from "./code-theme.js";
export { codeScopes, rolesFor } from "./code-theme.js";

/**
 * Builders, not themes.
 *
 * `github-dark` is a fixed set of hexes and ignores its argument; `atlas` is a view of the UI
 * palette and has to be rebuilt whenever that moves. Storing builders is what lets both live in one
 * registry without the palette-derived one going stale the moment it is registered.
 */
const CODE_THEME_BUILDERS = {
  "github-dark": (): CodeTheme => githubDark,
  atlas: buildAtlasCode,
} as const satisfies Record<string, () => CodeTheme>;

export type CodeThemeName = keyof typeof CODE_THEME_BUILDERS;

/** For a picker. In the registry's own order, which is the shipped order. */
export function codeThemeNames(): readonly CodeThemeName[] {
  // `filter` with the guard narrows `string[]` to `CodeThemeName[]` without a cast.
  return Object.keys(CODE_THEME_BUILDERS).filter(isCodeThemeName);
}

/** The fallback a resolver lands on when a stored name means nothing to this build. */
export const DEFAULT_CODE_THEME: CodeThemeName = "github-dark";

/** Narrowing for a name from outside the type system — a config file, a flag, an argv token. */
export function isCodeThemeName(name: string): name is CodeThemeName {
  return name in CODE_THEME_BUILDERS;
}

/** A name to a theme, without trusting the name. Unknown → `DEFAULT_CODE_THEME`, never a crash. */
export function resolveCodeTheme(name: string | null | undefined): CodeTheme {
  const key = name && isCodeThemeName(name) ? name : DEFAULT_CODE_THEME;
  return CODE_THEME_BUILDERS[key]();
}

let selected: CodeThemeName = DEFAULT_CODE_THEME;
let built: CodeTheme | null = null;

/**
 * The code theme in force, compiled once per (selection, palette).
 *
 * This used to be `export const codeTheme = CODE_THEMES[DEFAULT_CODE_THEME]` — one line that froze
 * the choice at import and made the whole registry above decorative: `resolveCodeTheme` had no
 * production caller, and `atlas` was unreachable dead code.
 */
export function codeTheme(): CodeTheme {
  built ??= CODE_THEME_BUILDERS[selected]();
  return built;
}

/** The current selection, for a picker that has to draw a checkmark somewhere. */
export function selectedCodeTheme(): CodeThemeName {
  return selected;
}

/** Switch themes. Unknown names fall back rather than throw — same contract as `resolveCodeTheme`. */
export function setCodeTheme(name: string | null | undefined): void {
  selected = name && isCodeThemeName(name) ? name : DEFAULT_CODE_THEME;
  built = null;
}

// `atlas` reads the UI palette, so a palette change invalidates the compiled theme as surely as a
// selection change does. Registering here rather than in the builder keeps `atlas.ts` a pure view.
onPaletteChange(() => {
  built = null;
});
