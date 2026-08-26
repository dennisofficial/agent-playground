import { theme } from '../../theme'
import type { CodeTheme } from './code-theme'

export const buildAtlasCode = (): CodeTheme => ({
  label: 'Atlas',
  roles: {
    plain: {},
    keyword: { fg: theme.accent, bold: true },
    string: { fg: theme.ok },
    escape: { fg: theme.dim },
    comment: { fg: theme.dim, italic: true },
    function: { fg: theme.code },
    type: { fg: theme.code },
    constant: { fg: theme.warn },
    key: { fg: theme.code },
    property: { fg: theme.code },
    variable: {},
    module: { fg: theme.code },
    attribute: { fg: theme.code },
    tag: { fg: theme.code },
    operator: { fg: theme.dim },
    punctuation: { fg: theme.dim },

    heading: { fg: theme.accent, bold: true },
    bold: { bold: true },
    italic: { italic: true },
    quote: { fg: theme.dim, italic: true },
    listMarker: { fg: theme.dim },
    link: { fg: theme.link, underline: true },
    rawInline: { fg: theme.hover, bg: theme.userBg },
    strikethrough: { fg: theme.hint },
  },

  diff: {
    added: { fg: theme.ok },
    removed: { fg: theme.error },
    hunk: { fg: theme.accent, bold: true },
    meta: { fg: theme.dim },
    context: {},
  },

  diffRows: {
    added: { gutter: { bg: theme.ok, fg: 'black' }, content: {} },
    removed: { gutter: { bg: theme.error, fg: 'black' }, content: { dim: true } },
    context: { gutter: { fg: theme.dim }, content: {} },
    gap: { gutter: {}, content: { fg: theme.dim } },
  },
})
