import { SyntaxStyle, type StyleDefinitionInput } from '@opentui/core'

import { onPaletteChange } from '../palette-store'
import { theme } from '../theme'
import { codeScopes, codeTheme, rolesFor, type CodeTheme } from './themes/index'

/**
 * Prose reaches `<markdown>` only inside a table now: everything else is drawn by `ProseView`.
 * These scopes are what a table cell resolves through, plus the two the renderable reads for its
 * own chrome — `conceal` for the box, `markup.heading` for the header row.
 */
const buildProseScopes = (): Record<string, StyleDefinitionInput> => ({
  default: { fg: theme.hover },

  conceal: { fg: theme.rule },

  'markup.heading': { fg: theme.meta },

  'markup.strong': { fg: theme.userFg, bold: true },
  'markup.bold': { fg: theme.userFg, bold: true },
  'markup.italic': { italic: true },
  'markup.strikethrough': { fg: theme.hint },

  'markup.quote': { fg: theme.meta },

  'markup.list': { fg: theme.hint },
  'markup.list.checked': { fg: theme.ok },
  'markup.list.unchecked': { fg: theme.hint },

  'markup.raw': { fg: theme.hover, bg: theme.userBg },
  'markup.raw.block': { fg: theme.code },

  'markup.link': { fg: theme.link, underline: true },
  'markup.link.url': { fg: theme.hint },
  'markup.link.label': { fg: theme.link, underline: true },
  'markup.link.bracket.close': { fg: theme.link, underline: true },

  'punctuation.special': { fg: theme.rule },
  'punctuation.delimiter': { fg: theme.hint },
  'string.escape': { fg: theme.hint },
  'keyword.directive': { fg: theme.hint },
  label: { fg: theme.hint },
  'character.special': {},
})

let proseScopesCache: Record<string, StyleDefinitionInput> | null = null
let proseSyntaxStyleCache: SyntaxStyle | null = null
const byFiletype = new Map<string, SyntaxStyle>()

export function proseScopes(): Record<string, StyleDefinitionInput> {
  proseScopesCache ??= buildProseScopes()
  return proseScopesCache
}

export function proseSyntaxStyle(): SyntaxStyle {
  proseSyntaxStyleCache ??= SyntaxStyle.fromStyles({
    ...codeScopes({ theme: codeTheme() }),
    ...proseScopes(),
  })
  return proseSyntaxStyleCache
}

export function buildCodeSyntaxStyle(args: { theme: CodeTheme; filetype?: string }): SyntaxStyle {
  return SyntaxStyle.fromStyles({
    ...codeScopes(args),
    default: rolesFor(args).plain,
  })
}

export function codeSyntaxStyleFor(filetype: string): SyntaxStyle {
  const cached = byFiletype.get(filetype)
  if (cached) return cached
  const built = buildCodeSyntaxStyle({ theme: codeTheme(), filetype })
  byFiletype.set(filetype, built)
  return built
}

onPaletteChange(() => {
  proseScopesCache = null
  proseSyntaxStyleCache = null
  byFiletype.clear()
})
