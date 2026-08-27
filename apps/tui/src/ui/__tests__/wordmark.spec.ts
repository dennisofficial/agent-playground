import { describe, expect, it } from 'bun:test'

import { theme } from '../theme'
import { wordmarkRows, WORDMARK_CELLS, WORDMARK_ROWS } from '../wordmark'

const rowsOf = (accent = theme.accent) =>
  wordmarkRows({ accent, ground: theme.appBg, bright: theme.bright })

const cellsOf = (spans: readonly { text: string }[]) =>
  spans.reduce((total, span) => total + span.text.length, 0)

describe('wordmarkRows', () => {
  it('emits one text row per pair of pixel rows', () => {
    expect(rowsOf()).toHaveLength(WORDMARK_ROWS)
  })

  it('never runs wider than the declared cell count', () => {
    for (const row of rowsOf()) expect(cellsOf(row)).toBeLessThanOrEqual(WORDMARK_CELLS)
  })

  it('paints ink with a half block carrying both a foreground and a background', () => {
    const inked = rowsOf().flat().filter((span) => span.text.includes('▀'))
    expect(inked.length).toBeGreaterThan(0)
    for (const span of inked) {
      expect(span.fg).toMatch(/^#[0-9a-f]{6}$/)
      expect(span.bg).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it('leaves blank cells untinted so the terminal ground shows through', () => {
    for (const span of rowsOf().flat()) {
      if (span.text.includes('▀')) continue
      expect(span.text.trim()).toBe('')
      expect(span.fg).toBeUndefined()
      expect(span.bg).toBeUndefined()
    }
  })

  it('merges neighbouring cells that share a tint', () => {
    for (const row of rowsOf()) {
      row.forEach((span, index) => {
        const next = row[index + 1]
        if (next === undefined) return
        expect(`${span.fg}/${span.bg}`).not.toBe(`${next.fg}/${next.bg}`)
      })
    }
  })

  it('falls the gradient from crest to foot down the mark', () => {
    const rows = rowsOf()
    const brightest = (index: number) =>
      Math.max(
        ...(rows[index] ?? [])
          .filter((span) => span.fg !== undefined)
          .map((span) => parseInt((span.fg ?? '#000000').slice(1), 16)),
      )
    expect(brightest(2)).toBeGreaterThan(brightest(rows.length - 2))
  })

  it('derives the whole mark from whichever accent it is given', () => {
    const clay = JSON.stringify(rowsOf(theme.accent))
    const moss = JSON.stringify(rowsOf('#7aa262'))
    expect(moss).not.toBe(clay)
    expect(moss).not.toContain(theme.accent)
  })
})
