import type { CodeTheme } from "./code-theme.js";
import { atlasCode } from "./atlas.js";
import { githubDark } from "./github-dark.js";

export type {
  CodeRole,
  CodeTheme,
  DiffPalette,
  DiffRowPalette,
  DiffRowStyle,
} from "./code-theme.js";
export { codeScopes, rolesFor } from "./code-theme.js";

export const CODE_THEMES = {
  "github-dark": githubDark,
  atlas: atlasCode,
} as const satisfies Record<string, CodeTheme>;

export type CodeThemeName = keyof typeof CODE_THEMES;

/** The fallback a resolver lands on when a stored name means nothing to this build. */
export const DEFAULT_CODE_THEME: CodeThemeName = "github-dark";

/** Narrowing for a name from outside the type system — a config file, a flag, an argv token. */
export function isCodeThemeName(name: string): name is CodeThemeName {
  return name in CODE_THEMES;
}

/** A name to a theme, without trusting the name. Unknown → `DEFAULT_CODE_THEME`, never a crash. */
export function resolveCodeTheme(name: string | null | undefined): CodeTheme {
  return name && isCodeThemeName(name)
    ? CODE_THEMES[name]
    : CODE_THEMES[DEFAULT_CODE_THEME];
}

export const codeTheme: CodeTheme = CODE_THEMES[DEFAULT_CODE_THEME];
