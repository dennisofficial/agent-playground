export { ACCENT, CODE_BLUE, theme } from './palette'
export type { Palette } from './palette'
export { glyph, SPINNER_FRAMES, SPINNER_FRAME_MS, spinnerFrame } from './glyphs'

export const ALT = process.platform === 'darwin' ? 'opt' : 'alt'

export const TRANSCRIPT_PADDING = 1

export const TRANSCRIPT_INSET = 1 + TRANSCRIPT_PADDING

export const SIDEBAR_WIDTH = 42

export const SIDEBAR_GUTTER = 2

export const SIDEBAR_FOLD_BELOW = 120

export const MIN_TRANSCRIPT_WIDTH = 40

export const SIDE_BY_SIDE_MIN_TERMINAL_WIDTH = 140

export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

const MERIDIEM_PIVOT = 12

export function formatClockTime(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''

  const hours = at.getHours()
  const minutes = String(at.getMinutes()).padStart(2, '0')
  const shown = hours % MERIDIEM_PIVOT === 0 ? MERIDIEM_PIVOT : hours % MERIDIEM_PIVOT

  return `${shown}:${minutes}${hours < MERIDIEM_PIVOT ? 'am' : 'pm'}`
}

const THOUSAND = 1_000
const MILLION = 1_000_000
const BILLION = 1_000_000_000

export function formatTokens(tokens: number): string {
  if (tokens < THOUSAND) return String(tokens)
  if (tokens < MILLION) return `${(tokens / THOUSAND).toFixed(1)}k`
  if (tokens < BILLION) return `${(tokens / MILLION).toFixed(2)}m`
  return `${(tokens / BILLION).toFixed(2)}b`
}
