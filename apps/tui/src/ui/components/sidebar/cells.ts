import { cellsOf } from '../../hint-layout'
import type { Span } from '../spans'

const ELLIPSIS = '…'

const GAP_CELLS = 1

export const SIDEBAR_INSET = 5

export const sidebarCells = (args: { width: number }): number =>
  Math.max(0, args.width - SIDEBAR_INSET)

export const sliceCells = (args: { text: string; cells: number }): string =>
  [...args.text].slice(0, Math.max(0, args.cells)).join('')

export function truncateCells(args: { text: string; cells: number }): string {
  if (cellsOf(args.text) <= args.cells) return args.text
  if (args.cells <= 1) return sliceCells(args)
  return `${sliceCells({ text: args.text, cells: args.cells - 1 })}${ELLIPSIS}`
}

export const spanCells = (spans: readonly Span[]): number =>
  spans.reduce((total, span) => total + cellsOf(span.text), 0)

export function clipSpans(args: { spans: readonly Span[]; cells: number }): Span[] {
  const kept: Span[] = []
  let used = 0
  for (const span of args.spans) {
    if (used >= args.cells) break
    const text = sliceCells({ text: span.text, cells: args.cells - used })
    used += cellsOf(text)
    kept.push({ ...span, text })
  }
  return kept
}

export function fitLabel(args: { label: string; valueCells: number; cells: number }): string {
  if (args.valueCells === 0) return truncateCells({ text: args.label, cells: args.cells })

  const room = args.cells - args.valueCells - GAP_CELLS
  if (room <= 0) return ''

  const kept = truncateCells({ text: args.label, cells: room })
  return `${kept}${' '.repeat(args.cells - cellsOf(kept) - args.valueCells)}`
}
