import { describe, expect, it } from 'bun:test'

import { EMeterBand } from '@dltech/atlas-core'

import { CONTEXT_WARN_PERCENT } from '../context-bar'
import {
  FOOTER_GUTTER,
  footerLayout,
  instrumentCells,
  type FooterLayout,
} from '../footer-layout'

const MODEL = 'haiku-4-5'

const METERS = [
  { label: '5h', band: EMeterBand.Normal, text: '34%' },
  { label: 'wk', band: EMeterBand.Normal, text: '61%' },
] as const

const at = (width: number): FooterLayout =>
  footerLayout({
    width,
    model: MODEL,
    effort: 'medium',
    context: { percent: 62, tokensUsed: 124_000, meters: METERS },
  })

const meterLabels = (layout: FooterLayout): readonly string[] =>
  (layout.instruments.context?.meters ?? []).map((meter) => meter.label)

const innerOf = (width: number): number => Math.max(0, width - FOOTER_GUTTER * 2)

const WIDTHS = Array.from({ length: 181 }, (unused, index) => 20 + index)

const widthWhereLost = (present: (layout: FooterLayout) => boolean): number => {
  for (let width = 200; width >= 20; width -= 1) if (!present(at(width))) return width
  return 0
}

const hasTail = (layout: FooterLayout): boolean =>
  layout.instruments.context?.text.includes('ctx') === true

const hasWeekly = (layout: FooterLayout): boolean => meterLabels(layout).includes('wk')

const hasSession = (layout: FooterLayout): boolean => meterLabels(layout).includes('5h')

const hasEffort = (layout: FooterLayout): boolean => layout.instruments.effort !== null

const hasModel = (layout: FooterLayout): boolean => layout.instruments.model !== null

describe('footerLayout at ease', () => {
  it('shows model, effort and the read-out when the terminal is wide', () => {
    expect(at(200).instruments).toEqual({
      model: MODEL,
      effort: 'med',
      context: { full: true, text: '124.0k ctx · 62%', meters: METERS },
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
      full: true,
      text: 'context 86% — /compact to compact',
      meters: [],
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

describe('footerLayout meters', () => {
  it('sheds the weekly window before the session one', () => {
    expect(meterLabels(at(widthWhereLost(hasWeekly)))).toEqual(['5h'])
  })

  it('carries no meters when it was given none', () => {
    const layout = footerLayout({
      width: 200,
      model: MODEL,
      context: { percent: 62, tokensUsed: 124_000 },
    })
    expect(layout.instruments.context).toEqual({
      full: true,
      text: '124.0k ctx · 62%',
      meters: [],
    })
  })

  it('still reports the windows when the context window is the thing under pressure', () => {
    const warned = footerLayout({
      width: 200,
      model: MODEL,
      effort: 'medium',
      context: { percent: 86, meters: METERS },
    })
    expect(warned.instruments.context?.text).toBe('context 86% — /compact to compact')
    expect(meterLabels(warned)).toEqual(['5h', 'wk'])
  })
})

describe('footerLayout under pressure', () => {
  it('drops in order: weekly, session, the tail, effort, then the model', () => {
    const order = [
      widthWhereLost(hasWeekly),
      widthWhereLost(hasSession),
      widthWhereLost(hasTail),
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
        instrumentCells({ instruments: layout.instruments }),
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
      layout.instruments.context?.text.includes('/compact to compact') === true
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
