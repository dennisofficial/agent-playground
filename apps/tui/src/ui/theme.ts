export { ACCENT, CODE_BLUE, theme } from './palette'
export type { Palette } from './palette'
export { glyph, SPINNER_FRAMES, SPINNER_FRAME_MS, spinnerFrame } from './glyphs'

export const ALT = process.platform === 'darwin' ? 'opt' : 'alt'

export const TRANSCRIPT_PADDING = 1

export const TRANSCRIPT_INSET = 1 + TRANSCRIPT_PADDING

export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}

export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens)
  return `${(tokens / 1000).toFixed(1)}k`
}
