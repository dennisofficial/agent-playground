import { SyntaxStyle, type StyleDefinitionInput } from '@opentui/core'

import { onPaletteChange } from '../palette-store'
import { theme } from '../theme'
import { codeScopes, codeTheme, rolesFor, type CodeTheme } from './themes/index'

const buildProseScopes = (): Record<string, StyleDefinitionInput> => ({
  default: {},

  'markup.heading.1': { fg: theme.accent, bold: true, italic: true, underline: true },
  'markup.heading.2': { fg: theme.accent, bold: true },
  'markup.heading.3': { fg: theme.accent, bold: true, dim: true },
  'markup.heading.4': { fg: theme.accent, bold: true, dim: true },
  'markup.heading.5': { fg: theme.accent, bold: true, dim: true },
  'markup.heading.6': { fg: theme.accent, bold: true, dim: true },
  'markup.heading': { fg: theme.accent, bold: true },

  'markup.strong': { bold: true },
  'markup.bold': { bold: true },
  'markup.italic': { italic: true },
  'markup.strikethrough': { dim: true },

  'markup.quote': { fg: theme.dim, italic: true },

  'markup.list': { fg: theme.dim },
  'markup.list.checked': { fg: theme.ok },
  'markup.list.unchecked': { fg: theme.dim },

  'markup.raw': { fg: theme.codeInline },
  'markup.raw.block': { fg: theme.code },

  'markup.link': { fg: theme.link, underline: true },
  'markup.link.url': { fg: theme.link, underline: true },
  'markup.link.label': { fg: theme.link, underline: true },
  'markup.link.bracket.close': { fg: theme.link, underline: true },

  'punctuation.special': { fg: theme.dim },
  'punctuation.delimiter': { fg: theme.dim },
  'string.escape': { fg: theme.dim },
  'keyword.directive': { fg: theme.dim },
  label: { fg: theme.dim },
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

export function buildCodeSyntaxStyle(args: {
  theme: CodeTheme
  filetype?: string
}): SyntaxStyle {
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
