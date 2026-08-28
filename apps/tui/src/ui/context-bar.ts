import { theme } from './theme'

export const CONTEXT_BAR_GLYPH = '█'

export const CONTEXT_BAR_CELLS = 10

export const CONTEXT_WARN_PERCENT = 75

export const COMPACT_COMMAND = '/compact'

export type ContextBarCells = { ok: number; warn: number; empty: number }

function clamped(args: { value: number; ceiling: number }): number {
  return Math.min(args.ceiling, Math.max(0, args.value))
}

export function contextBarCells(args: { percent: number; cells: number }): ContextBarCells {
  const cells = Math.max(0, Math.floor(args.cells))
  const asked = Math.round((args.percent / 100) * cells)
  const filled = clamped({
    value: args.percent > 0 ? Math.max(1, asked) : asked,
    ceiling: cells,
  })
  const comfortable = clamped({
    value: Math.round((CONTEXT_WARN_PERCENT / 100) * cells),
    ceiling: cells,
  })
  const ok = Math.min(filled, comfortable)
  return { ok, warn: filled - ok, empty: cells - filled }
}

export function isContextWarning(percent: number): boolean {
  return percent > CONTEXT_WARN_PERCENT
}

export function contextTone(percent: number): string {
  return isContextWarning(percent) ? theme.warn : theme.meta
}
