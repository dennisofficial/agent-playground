import type { CodeTheme } from './code-theme'

const INK = {
  fg: '#e6edf3',
  grey: '#8b949e',
  red: '#ff7b72',
  blue: '#79c0ff',
  paleBlue: '#a5d6ff',
  purple: '#d2a8ff',
  orange: '#ffa657',
  green: '#7ee787',
  paleRed: '#ffa198',
  addedBg: '#04260f',
  removedBg: '#490202',
  addedGutterBg: '#0f5323',
  removedGutterBg: '#8e1519',
  paleGreen: '#aff5b4',
  palerRed: '#ffdcd7',
} as const

export const githubDark: CodeTheme = {
  label: 'GitHub Dark',
  roles: {
    plain: { fg: INK.fg },
    keyword: { fg: INK.red },
    string: { fg: INK.paleBlue },
    escape: { fg: INK.red },
    comment: { fg: INK.grey },
    function: { fg: INK.purple },
    type: { fg: INK.orange },
    constant: { fg: INK.blue },
    key: { fg: INK.green },
    property: { fg: INK.fg },
    variable: { fg: INK.fg },
    module: { fg: INK.blue },
    attribute: { fg: INK.blue },
    tag: { fg: INK.green },
    operator: { fg: INK.red },
    punctuation: { fg: INK.fg },

    heading: { fg: INK.blue, bold: true },
    bold: { fg: INK.fg, bold: true },
    italic: { fg: INK.fg, italic: true },
    quote: { fg: INK.green },
    listMarker: { fg: INK.orange },
    link: { fg: INK.paleBlue },
    rawInline: { fg: INK.blue },
    strikethrough: { fg: INK.grey, dim: true },
  },

  overrides: {
    yaml: { property: { fg: INK.green } },
    css: { property: { fg: INK.blue }, variable: { fg: INK.orange } },
  },

  diff: {
    added: { fg: INK.green, bg: INK.addedBg },
    removed: { fg: INK.paleRed, bg: INK.removedBg },
    hunk: { fg: INK.purple, bold: true },
    meta: { fg: INK.blue },
    context: { fg: INK.fg },
  },

  diffRows: {
    added: { gutter: { bg: INK.addedGutterBg, fg: INK.paleGreen }, content: {} },
    removed: { gutter: { bg: INK.removedGutterBg, fg: INK.palerRed }, content: { dim: true } },
    context: { gutter: { fg: INK.grey }, content: {} },
    gap: { gutter: {}, content: { fg: INK.grey } },
  },
}
