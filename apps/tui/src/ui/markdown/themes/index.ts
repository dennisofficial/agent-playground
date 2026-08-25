import { onPaletteChange } from '../../palette-store'
import { buildAtlasCode } from './atlas'
import type { CodeTheme } from './code-theme'
import { githubDark } from './github-dark'

export type { CodeRole, CodeTheme, DiffPalette, DiffRowPalette, DiffRowStyle } from './code-theme'
export { codeScopes, EDiffLineKind, rolesFor } from './code-theme'

const CODE_THEME_BUILDERS = {
  'github-dark': (): CodeTheme => githubDark,
  atlas: buildAtlasCode,
} as const satisfies Record<string, () => CodeTheme>

export type CodeThemeName = keyof typeof CODE_THEME_BUILDERS

export function codeThemeNames(): readonly CodeThemeName[] {
  return Object.keys(CODE_THEME_BUILDERS).filter(isCodeThemeName)
}

export const DEFAULT_CODE_THEME: CodeThemeName = 'github-dark'

export function isCodeThemeName(name: string): name is CodeThemeName {
  return name in CODE_THEME_BUILDERS
}

export function resolveCodeTheme(name: string | null | undefined): CodeTheme {
  const key = name && isCodeThemeName(name) ? name : DEFAULT_CODE_THEME
  return CODE_THEME_BUILDERS[key]()
}

let selected: CodeThemeName = DEFAULT_CODE_THEME
let built: CodeTheme | null = null

export function codeTheme(): CodeTheme {
  built ??= CODE_THEME_BUILDERS[selected]()
  return built
}

export function selectedCodeTheme(): CodeThemeName {
  return selected
}

export function setCodeTheme(name: string | null | undefined): void {
  selected = name && isCodeThemeName(name) ? name : DEFAULT_CODE_THEME
  built = null
}

onPaletteChange(() => {
  built = null
})
