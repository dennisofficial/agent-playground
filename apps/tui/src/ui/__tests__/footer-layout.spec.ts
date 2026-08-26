import { describe, expect, it } from 'bun:test'

import { CONTEXT_BAR_CELLS, CONTEXT_WARN_PERCENT } from '../context-bar'
import {
  FOOTER_GUTTER,
  footerLayout,
  instrumentCells,
  type FooterLayout,
} from '../footer-layout'

const MODEL = 'haiku-4-5'

const at = (width: number): FooterLayout =>
  footerLayout({
    width,
    model: MODEL,
    effort: 'medium',
    context: { percent: 62, tokensLeft: 124_000 },
  })

const innerOf = (width: number): number => Math.max(0, width - FOOTER_GUTTER * 2)

const WIDTHS = Array.from({ length: 181 }, (unused, index) => 20 + index)

const widthWhereLost = (present: (layout: FooterLayout) => boolean): number => {
  for (let width = 200; width >= 20; width -= 1) if (!present(at(width))) return width
  return 0
}

const hasTail = (layout: FooterLayout): boolean =>
  layout.instruments.context?.text.includes('left') === true

const hasBar = (layout: FooterLayout): boolean => layout.instruments.context?.bar === true

const hasEffort = (layout: FooterLayout): boolean => layout.instruments.effort !== null

const hasModel = (layout: FooterLayout): boolean => layout.instruments.model !== null

describe('footerLayout at ease', () => {
  it('shows model, effort and the read-out when the terminal is wide', () => {
    expect(at(200).instruments).toEqual({
      model: MODEL,
      effort: 'med',
      context: { bar: true, text: '62% · 124.0k left' },
    })
  })

  it('names the effort without spelling out the word', () => {
    expect(footerLayout({ width: 200, model: MODEL, effort: 'low' }).instruments.effort).toBe('low')
    expect(footerLayout({ width: 200, model: MODEL, effort: 'high' }).instruments.effort).toBe('high')
  })

  it('spells out the consequence once the window is under pressure', () => {
    const layout = footerLayout({
      width: 200,
      model: MODEL,
      effort: 'medium',
      context: { percent: 86 },
    })
    expect(layout.instruments.context).toEqual({
      bar: true,
      text: 'context 86% — compacts at 90',
    })
  })

  it('shows no read-out at all when there is no context to report', () => {
    const layout = footerLayout({ width: 200, model: MODEL })
    expect(layout.instruments.context).toBeNull()
    expect(layout.instruments.effort).toBeNull()
    expect(layout.instruments.model).toBe(MODEL)
  })

  it('says nothing about where you are — the sidebar names the directory', () => {
    expect(Object.keys(at(200).instruments).sort()).toEqual(['context', 'effort', 'model'])
  })
})

describe('footerLayout under pressure', () => {
  it('drops in order: the tail, the bar, effort, then the model', () => {
    const order = [
      widthWhereLost(hasTail),
      widthWhereLost(hasBar),
      widthWhereLost(hasEffort),
      widthWhereLost(hasModel),
    ]
    expect(order).toEqual([...order].sort((left, right) => right - left))
    expect(new Set(order).size).toBe(order.length)
  })

  it('keeps the percentage read-out through every drop', () => {
    for (const width of WIDTHS) expect(at(width).instruments.context?.text).toContain('62%')
  })

  it('never claims more cells than the width allows', () => {
    for (const width of WIDTHS) {
      expect(at(width).instrumentCells).toBeLessThanOrEqual(innerOf(width))
    }
  })

  it('reports the cells its own instruments take', () => {
    for (const width of WIDTHS) {
      const layout = at(width)
      expect(layout.instrumentCells).toBe(
        instrumentCells({ instruments: layout.instruments, barCells: CONTEXT_BAR_CELLS }),
      )
    }
  })

  it('goes silent rather than overrunning a terminal too narrow for even a percentage', () => {
    expect(at(6).instruments).toEqual({ model: null, effort: null, context: null })
    expect(at(6).instrumentCells).toBe(0)
  })

  it('keeps the warning sentence after every other instrument has left', () => {
    const warned = (width: number): FooterLayout =>
      footerLayout({
        width,
        model: MODEL,
        effort: 'medium',
        context: { percent: CONTEXT_WARN_PERCENT + 11 },
      })
    const spelled = (layout: FooterLayout): boolean =>
      layout.instruments.context?.text.includes('compacts at 90') === true
    for (let width = 200; width >= 40; width -= 1) {
      const layout = warned(width)
      if (!spelled(layout)) {
        expect(layout.instruments.model).toBeNull()
        expect(layout.instruments.effort).toBeNull()
        break
      }
    }
  })
})
