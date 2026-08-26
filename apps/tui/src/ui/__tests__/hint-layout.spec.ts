import { describe, expect, it } from 'bun:test'

import { cellsOf, fitHints, hintSpans, hintWidth, type Hint } from '../hint-layout'
import { theme } from '../theme'

const HINTS: readonly Hint[] = [
  { key: '⏎', label: 'send' },
  { key: '⇧⏎', label: 'newline' },
  { key: 'ctrl+n', label: 'new' },
]

describe('hintWidth', () => {
  it('is zero for no hints', () => {
    expect(hintWidth([])).toBe(0)
  })

  it('counts a glyph key as one cell', () => {
    expect(hintWidth([{ key: '⏎', label: 'send' }])).toBe(cellsOf('⏎ send'))
  })

  it('counts the separator between hints', () => {
    expect(hintWidth(HINTS)).toBe(cellsOf('⏎ send · ⇧⏎ newline · ctrl+n new'))
  })
})

describe('fitHints', () => {
  it('keeps every hint when the row has room', () => {
    expect(fitHints({ hints: HINTS, cells: 200 })).toEqual(HINTS)
  })

  it('drops from the tail, keeping the most wanted', () => {
    const kept = fitHints({ hints: HINTS, cells: cellsOf('⏎ send · ⇧⏎ newline') })
    expect(kept).toEqual(HINTS.slice(0, 2))
  })

  it('never drops the last hint, however narrow the row', () => {
    expect(fitHints({ hints: HINTS, cells: 0 })).toEqual(HINTS.slice(0, 1))
  })
})

describe('hintSpans', () => {
  it('opens on a key rather than a separator', () => {
    const spans = hintSpans({ hints: HINTS, keyColour: theme.accent })
    expect(spans[0]).toEqual({ text: '⏎', fg: theme.accent })
  })

  it('paints keys, labels and separators on distinct tiers', () => {
    const spans = hintSpans({ hints: HINTS, keyColour: theme.accent })
    const tiers = new Set(spans.map((span) => span.fg))
    expect(tiers).toEqual(new Set([theme.accent, theme.hint, theme.rule]))
  })

  it('renders back to the spelled row', () => {
    const spans = hintSpans({ hints: HINTS, keyColour: theme.accent })
    expect(spans.map((span) => span.text).join('')).toBe('⏎ send · ⇧⏎ newline · ctrl+n new')
  })
})
