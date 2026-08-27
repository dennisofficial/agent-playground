import { ACCENT, SHIPPED_PALETTE, type Palette } from './palette'

const ACCENTS: Readonly<Record<string, string>> = {
  clay: ACCENT,
  slate: '#7f9cc0',
  moss: '#7aa262',
  plum: '#b08cd0',
}

export const accentHex = (name: string): string => ACCENTS[name] ?? ACCENT

export function accentPalette(name: string): Partial<Palette> {
  const accent = accentHex(name)

  return {
    accent,
    caretBg: accent,
    codeInline: accent,
    court: { ...SHIPPED_PALETTE.court, agent: accent, yours: accent },
  }
}
