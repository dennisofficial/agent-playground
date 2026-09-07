import { describe, expect, it } from 'bun:test'

import { EEffort, EMeterBand } from '@dltech/atlas-core'

import { CONTEXT_WARN_PERCENT } from '../context-bar'
import { EFooterItemReach, type FooterItem } from '../footer-item'
import {
  FOOTER_GUTTER,
  footerLayout,
  instrumentCells,
  readouts,
  UNMEASURED_CONTEXT,
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
    effort: EEffort.Medium,
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

const hasEffort = (layout: FooterLayout): boolean => layout.instruments.effort !== null

const hasModel = (layout: FooterLayout): boolean => layout.instruments.model !== null

describe('footerLayout at ease', () => {
  it('shows model, effort and the read-out when the terminal is wide', () => {
    expect(at(200).instruments).toEqual({
      model: MODEL,
      effort: 'med',
      items: [],
      context: { full: true, text: '124.0k 62%', meters: METERS },
      rows: 1,
    })
  })

  it('names the effort without spelling out the word', () => {
    expect(footerLayout({ width: 200, model: MODEL, effort: EEffort.Low }).instruments.effort).toBe(
      'low',
    )
    expect(
      footerLayout({ width: 200, model: MODEL, effort: EEffort.High }).instruments.effort,
    ).toBe('high')
  })

  it('spells out the consequence once the window is under pressure', () => {
    const layout = footerLayout({
      width: 200,
      model: MODEL,
      effort: EEffort.Medium,
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
    expect(Object.keys(at(200).instruments).sort()).toEqual([
      'context',
      'effort',
      'items',
      'model',
      'rows',
    ])
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
      text: '124.0k 62%',
      meters: [],
    })
  })

  it('still reports the windows when the context window is the thing under pressure', () => {
    const warned = footerLayout({
      width: 200,
      model: MODEL,
      effort: EEffort.Medium,
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
      expect(layout.instrumentCells).toBe(instrumentCells({ instruments: layout.instruments }))
    }
  })

  it('goes silent rather than overrunning a terminal too narrow for even a percentage', () => {
    expect(at(4).instruments).toEqual({
      model: null,
      effort: null,
      items: [],
      context: null,
      rows: 1,
    })
    expect(at(4).instrumentCells).toBe(0)
  })

  it('keeps the warning sentence after every other instrument has left', () => {
    const warned = (width: number): FooterLayout =>
      footerLayout({
        width,
        model: MODEL,
        effort: EEffort.Medium,
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
    model: MODEL,
    effort: EEffort.Medium,
    items: PILLS,
    context: { percent: 62, tokensUsed: 124_000, meters: METERS },
  })

const itemIds = (layout: FooterLayout): readonly string[] =>
  layout.instruments.items.map((item) => item.id)

describe('footerLayout carrying items', () => {
  it('shows every pill when the terminal has the room', () => {
    expect(itemIds(withItems(200))).toEqual(['pr', 'shells'])
  })

  it('charges the chips their single-cell gaps and the one lead separator', () => {
    const spelled = instrumentCells({ instruments: withItems(200).instruments })
    const bare = instrumentCells({ instruments: at(200).instruments })
    expect(spelled - bare).toBe(4 + 8 + 1 + 3)
  })

  it('keeps everything on one row while the row fits it all', () => {
    expect(withItems(55).instruments.rows).toBe(1)
    expect(itemIds(withItems(55))).toEqual(['pr', 'shells'])
  })

  it('wraps the pills beneath the facts and the read-out the moment one row runs out', () => {
    const wrapped = withItems(54)
    expect(wrapped.instruments.rows).toBe(2)
    expect(itemIds(wrapped)).toEqual(['pr', 'shells'])
    expect(meterLabels(wrapped)).toEqual(['5h', 'wk'])
  })

  it('sheds the weekly meter on the head row before the session one, pills untouched', () => {
    const squeezed = withItems(32)
    expect(squeezed.instruments.rows).toBe(2)
    expect(itemIds(squeezed)).toEqual(['pr', 'shells'])
    expect(meterLabels(squeezed)).toEqual(['5h'])
  })

  it('keeps every pill until the head row itself runs out of room', () => {
    const narrowest = withItems(18)
    expect(narrowest.instruments.rows).toBe(2)
    expect(itemIds(narrowest)).toEqual(['pr', 'shells'])
    expect(narrowest.instruments.context?.text).toBe('62%')
    expect(itemIds(withItems(17))).toEqual([])
  })

  it('sheds from the tail of the pill row only when that row alone is too wide', () => {
    const many: readonly FooterItem[] = [
      ...PILLS,
      { id: 'agents', spans: [{ text: 'agents 12' }], reach: EFooterItemReach.Keyboard },
      { id: 'services', spans: [{ text: 'services 3' }], reach: EFooterItemReach.Keyboard },
    ]
    const laid = (width: number): FooterLayout =>
      footerLayout({ width, model: MODEL, effort: EEffort.Medium, items: many })

    expect(itemIds(laid(36))).toEqual(['pr', 'shells', 'agents', 'services'])
    expect(itemIds(laid(30))).toEqual(['pr', 'shells', 'agents'])
  })

  it('always spells the model beside a pill, on whichever row the pill lands', () => {
    for (const width of WIDTHS) {
      const layout = withItems(width)
      if (layout.instruments.items.length === 0) continue

      expect(layout.instruments.model).not.toBeNull()
      expect(layout.instruments.effort).not.toBeNull()
      expect(layout.instruments.context).not.toBeNull()
    }
  })

  it('promises only the model beside a pill — the rest ride along if they were given at all', () => {
    const spare = footerLayout({ width: 200, model: MODEL, items: PILLS })
    expect(itemIds(spare)).toEqual(['pr', 'shells'])
    expect(spare.instruments.model).toBe(MODEL)
    expect(spare.instruments.effort).toBeNull()
    expect(spare.instruments.context).toBeNull()
  })

  it('never claims more cells than the width allows, pills included', () => {
    for (const width of WIDTHS) {
      expect(withItems(width).instrumentCells).toBeLessThanOrEqual(innerOf(width))
    }
  })

  it('spends its cells on the wider of the two rows once wrapped', () => {
    for (const width of WIDTHS) {
      const layout = withItems(width)
      const { instruments } = layout
      if (instruments.rows !== 2) continue

      const head = instrumentCells({ instruments: { ...instruments, items: [], rows: 1 } })
      const tail = instrumentCells({
        instruments: { ...instruments, model: null, effort: null, context: null, rows: 1 },
      })
      expect(layout.instrumentCells).toBe(Math.max(head, tail))
    }
  })

  it('still goes silent on a terminal too narrow for anything', () => {
    expect(withItems(4).instruments).toEqual({
      model: null,
      effort: null,
      items: [],
      context: null,
      rows: 1,
    })
  })
})

describe('a context window nothing measured', () => {
  it('says the slot is unknown rather than reading zero', () => {
    const forms = readouts({ percent: 0, measured: false, meters: [] })
    for (const form of forms) expect(form.text).toContain(UNMEASURED_CONTEXT)
    expect(forms.some((form) => form.text.includes('0%'))).toBe(false)
  })

  it('outranks the model and the effort, the way a warning does', () => {
    const laid = footerLayout({
      width: 40,
      model: MODEL,
      effort: EEffort.Medium,
      context: { percent: 0, measured: false, meters: [] },
    })
    expect(laid.instruments.context?.text).toContain(UNMEASURED_CONTEXT)
  })

  it('keeps a form narrow enough to survive a cramped row', () => {
    const laid = footerLayout({
      width: FOOTER_GUTTER * 2 + UNMEASURED_CONTEXT.length,
      model: MODEL,
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
