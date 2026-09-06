import { describe, expect, it } from 'bun:test'

import { EMeterBand } from '@dltech/atlas-core'

import { CONTEXT_WARN_PERCENT } from '../context-bar'
import { EFooterItemReach, footerItemCells, type FooterItem } from '../footer-item'
import {
  FOOTER_GUTTER,
  footerLayout,
  instrumentCells,
  readouts,
  UNMEASURED_CONTEXT,
  type FooterLayout,
} from '../footer-layout'

const METERS = [
  { label: '5h', band: EMeterBand.Normal, text: '34%' },
  { label: 'wk', band: EMeterBand.Normal, text: '61%' },
] as const

const at = (width: number): FooterLayout =>
  footerLayout({
    width,
    context: { percent: 62, tokensUsed: 124_000, meters: METERS },
  })

const meterLabels = (layout: FooterLayout): readonly string[] =>
  (layout.instruments.context?.meters ?? []).map((meter) => meter.label)

const innerOf = (width: number): number => Math.max(0, width - FOOTER_GUTTER * 2)

const WIDTHS = Array.from({ length: 181 }, (unused, index) => 20 + index)

const widthWhereLost = (present: (layout: FooterLayout) => boolean): number => {
  for (let width = 200; width >= 0; width -= 1) if (!present(at(width))) return width
  return -1
}

const hasTail = (layout: FooterLayout): boolean =>
  layout.instruments.context?.text.includes('124.0k') === true

const hasWeekly = (layout: FooterLayout): boolean => meterLabels(layout).includes('wk')

const hasSession = (layout: FooterLayout): boolean => meterLabels(layout).includes('5h')

describe('footerLayout at ease', () => {
  it('shows the read-out in full when the terminal is wide', () => {
    expect(at(200).instruments).toEqual({
      items: [],
      context: { full: true, text: '124.0k 62%', meters: METERS },
    })
  })

  it('spells out the consequence once the window is under pressure', () => {
    const layout = footerLayout({
      width: 200,
      context: { percent: 86 },
    })
    expect(layout.instruments.context).toEqual({
      full: true,
      text: 'context 86% — /compact to compact',
      meters: [],
    })
  })

  it('shows no read-out at all when there is no context to report', () => {
    const layout = footerLayout({ width: 200 })
    expect(layout.instruments.context).toBeNull()
    expect(layout.instruments.items).toEqual([])
  })

  it('says nothing about what is answering — the composer foot names the model', () => {
    expect(Object.keys(at(200).instruments).sort()).toEqual(['context', 'items'])
  })
})

describe('footerLayout meters', () => {
  it('sheds the weekly window before the session one', () => {
    expect(meterLabels(at(widthWhereLost(hasWeekly)))).toEqual(['5h'])
  })

  it('carries no meters when it was given none', () => {
    const layout = footerLayout({
      width: 200,
      context: { percent: 62, tokensUsed: 124_000 },
    })
    expect(layout.instruments.context).toEqual({
      full: true,
      text: '124.0k 62%',
      meters: [],
    })
  })

  it('still reports the windows when the context window is the thing under pressure', () => {
    const warned = footerLayout({
      width: 200,
      context: { percent: 86, meters: METERS },
    })
    expect(warned.instruments.context?.text).toBe('context 86% — /compact to compact')
    expect(meterLabels(warned)).toEqual(['5h', 'wk'])
  })
})

describe('footerLayout under pressure', () => {
  it('drops in order: weekly, session, then the tail', () => {
    const order = [
      widthWhereLost(hasWeekly),
      widthWhereLost(hasSession),
      widthWhereLost(hasTail),
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
      expect(layout.instrumentCells).toBe(instrumentCells({ instruments: layout.instruments }))
    }
  })

  it('goes silent rather than overrunning a terminal too narrow for even a percentage', () => {
    expect(at(4).instruments).toEqual({
      items: [],
      context: null,
    })
    expect(at(4).instrumentCells).toBe(0)
  })

  it('keeps the warning sentence until the row itself runs out', () => {
    const warned = (width: number): FooterLayout =>
      footerLayout({
        width,
        context: { percent: CONTEXT_WARN_PERCENT + 11 },
      })
    const spelled = (layout: FooterLayout): boolean =>
      layout.instruments.context?.text.includes('/compact to compact') === true
    for (let width = 200; width >= 40; width -= 1) {
      expect(spelled(warned(width))).toBe(true)
    }
  })
})

const PILLS: readonly FooterItem[] = [
  {
    id: 'pr',
    spans: [{ text: '#123' }],
    reach: EFooterItemReach.Keyboard,
  },
  {
    id: 'shells',
    spans: [{ text: '2 shells' }],
    reach: EFooterItemReach.Keyboard,
  },
]

const withItems = (width: number): FooterLayout =>
  footerLayout({
    width,
    items: PILLS,
    context: { percent: 62, tokensUsed: 124_000, meters: METERS },
  })

const itemIds = (layout: FooterLayout): readonly string[] =>
  layout.instruments.items.map((item) => item.id)

const lostWithItems = (present: (layout: FooterLayout) => boolean): number => {
  for (let width = 200; width >= 20; width -= 1) if (!present(withItems(width))) return width
  return 0
}

describe('footerLayout carrying items', () => {
  it('shows every pill when the terminal has the room', () => {
    expect(itemIds(withItems(200))).toEqual(['pr', 'shells'])
  })

  it('charges the chips their single-cell gaps and nothing more', () => {
    const spelled = instrumentCells({ instruments: withItems(200).instruments })
    const bare = instrumentCells({ instruments: at(200).instruments })
    expect(spelled - bare).toBe(4 + 8 + 1)
  })

  it('sheds the pills before the weekly meter, which is the first instrument to go', () => {
    expect(lostWithItems((layout) => layout.instruments.items.length > 0)).toBeGreaterThan(
      lostWithItems(hasWeekly),
    )
  })

  it('sheds from the tail, so the first pill outlives the second', () => {
    const width = lostWithItems((layout) => layout.instruments.items.length === PILLS.length)
    expect(itemIds(withItems(width))).toEqual(['pr'])
  })

  it('never leaves a pill beside a read-out that has already started degrading', () => {
    for (const width of WIDTHS) {
      const layout = withItems(width)
      if (layout.instruments.items.length === 0) continue

      expect(layout.instruments.context?.full).toBe(true)
      expect(meterLabels(layout)).toEqual(['5h', 'wk'])
    }
  })

  it('carries the pills alone when no read-out was given at all', () => {
    const spare = footerLayout({ width: 200, items: PILLS })
    expect(itemIds(spare)).toEqual(['pr', 'shells'])
    expect(spare.instruments.context).toBeNull()
  })

  it('never claims more cells than the width allows, pills included', () => {
    for (const width of WIDTHS) {
      expect(withItems(width).instrumentCells).toBeLessThanOrEqual(innerOf(width))
    }
  })

  it('spends its cells on the pills it kept and charges nothing for the ones it shed', () => {
    for (const width of WIDTHS) {
      const layout = withItems(width)
      const kept =
        layout.instruments.items.reduce((total, pill) => total + footerItemCells(pill), 0) +
        Math.max(0, layout.instruments.items.length - 1)
      expect(layout.instrumentCells - instrumentCells({ instruments: at(width).instruments })).toBe(
        layout.instruments.items.length === 0 ? 0 : kept,
      )
    }
  })

  it('still goes silent on a terminal too narrow for anything', () => {
    expect(withItems(4).instruments).toEqual({
      items: [],
      context: null,
    })
  })
})

describe('a context window nothing measured', () => {
  it('says the slot is unknown rather than reading zero', () => {
    const forms = readouts({ percent: 0, measured: false, meters: [] })
    for (const form of forms) expect(form.text).toContain(UNMEASURED_CONTEXT)
    expect(forms.some((form) => form.text.includes('0%'))).toBe(false)
  })

  it('keeps the slot spelled on a cramped row, the way a warning does', () => {
    const laid = footerLayout({
      width: 40,
      context: { percent: 0, measured: false, meters: [] },
    })
    expect(laid.instruments.context?.text).toContain(UNMEASURED_CONTEXT)
  })

  it('keeps a form narrow enough to survive a cramped row', () => {
    const laid = footerLayout({
      width: FOOTER_GUTTER * 2 + UNMEASURED_CONTEXT.length,
      context: { percent: 0, measured: false, meters: [] },
    })
    expect(laid.instruments.context?.text).toBe(UNMEASURED_CONTEXT)
    expect(laid.instrumentCells).toBeLessThanOrEqual(UNMEASURED_CONTEXT.length)
  })

  it('leaves an ordinary reading alone', () => {
    const forms = readouts({ percent: 42, tokensUsed: 1200, meters: [] })
    for (const form of forms) expect(form.text).not.toContain(UNMEASURED_CONTEXT)
  })
})
