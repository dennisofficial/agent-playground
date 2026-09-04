export const ACCENT = '#d97757'

export const CODE_BLUE = '#7cbdff'

/** The steel blue the legacy web app used for its `--blue` token in dark mode. */
export const SERVICE_BLUE = '#7d9be0'

export type DiffTints = {
  addBg: string
  removeBg: string
  wordBg: string
  bandBg: string
  gutterFg: string
}

export type Palette = {
  appBg: string
  accent: string
  dim: string
  hover: string
  bright: string
  body: string
  rule: string
  hint: string
  meta: string
  hoverBg: string
  selectedBg: string
  error: string
  warn: string
  ok: string
  okBright: string
  userBg: string
  userFg: string
  userBand: string
  harnessBg: string
  harnessFg: string
  caretBg: string
  caretFg: string
  overlayBg: string
  panelBg: string
  panelBand: string
  code: string
  link: string
  codeInline: string
  court: {
    agent: string
    yours: string
    external: string
    none: string
  }
  diff: DiffTints
}

export const theme: Palette = {
  appBg: '#282422',
  accent: ACCENT,
  dim: '#6b625c',
  hover: '#e6e0da',
  bright: '#f0e9e3',
  body: '#c8b5ad',
  rule: '#3a3532',
  hint: '#6b625c',
  meta: '#8a8078',
  hoverBg: '#2b2724',
  selectedBg: '#3a332e',
  error: '#e5534b',
  warn: '#e3b341',
  ok: '#57ab5a',
  okBright: '#7ee787',
  userBg: '#332e2a',
  userFg: '#f0e9e3',
  userBand: '#2b2724',
  harnessBg: '#3d2318',
  harnessFg: '#f3e3d8',
  caretBg: ACCENT,
  caretFg: '#241f1c',
  overlayBg: '#241f1c',
  panelBg: '#1e1a17',
  panelBand: '#241f1c',
  code: CODE_BLUE,
  link: CODE_BLUE,
  codeInline: ACCENT,
  court: {
    agent: ACCENT,
    yours: ACCENT,
    external: '#b392f0',
    none: '#6b625c',
  },
  /**
   * A terminal cell has no alpha, so the design's `rgba(87,171,90,.13)` over `#1e1a17` is stored
   * pre-composited against the panel ground it is specified over.
   */
  diff: {
    addBg: '#252d20',
    removeBg: '#322020',
    wordBg: '#335030',
    bandBg: '#241f1c',
    gutterFg: '#8a8078',
  },
}

export const SHIPPED_PALETTE: Palette = structuredClone(theme)
