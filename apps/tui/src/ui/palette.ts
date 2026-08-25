export const ACCENT = '#d97757'

export const CODE_BLUE = '#7cbdff'

export type Palette = {
  accent: string
  dim: string
  hover: string
  rule: string
  meta: string
  hoverBg: string
  error: string
  warn: string
  ok: string
  okBright: string
  userBg: string
  userFg: string
  harnessBg: string
  harnessFg: string
  caretBg: string
  caretFg: string
  overlayBg: string
  code: string
  link: string
  codeInline: string
  court: {
    agent: string
    yours: string
    external: string
    none: string
  }
}

export const theme: Palette = {
  accent: ACCENT,
  dim: 'gray',
  hover: '#e6e0da',
  rule: '#3a3532',
  meta: '#8a8078',
  hoverBg: '#2b2724',
  error: 'red',
  warn: 'yellow',
  ok: 'green',
  okBright: '#7ee787',
  userBg: '#332e2a',
  userFg: '#f0e9e3',
  harnessBg: '#3d2318',
  harnessFg: '#f3e3d8',
  caretBg: ACCENT,
  caretFg: '#241f1c',
  overlayBg: '#241f1c',
  code: CODE_BLUE,
  link: CODE_BLUE,
  codeInline: ACCENT,
  court: {
    agent: ACCENT,
    yours: '#e3b341',
    external: '#b392f0',
    none: 'gray',
  },
}

export const SHIPPED_PALETTE: Palette = structuredClone(theme)
