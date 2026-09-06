import { COMPACT_COMMAND, isContextWarning } from './context-bar'
import { footerItemCells, itemLadder, NO_FOOTER_ITEMS, type FooterItem } from './footer-item'
import { cellsOf } from './hint-layout'
import { formatTokens, glyph } from './theme'
import type { FooterMeter } from './usage-meters'

export const FOOTER_GUTTER = 1

export type FooterContext = {
  percent: number
  tokensUsed?: number
  meters?: readonly FooterMeter[]
  measured?: boolean
}

export const UNMEASURED_CONTEXT = 'ctx ?'

export const isMeasured = (context: FooterContext): boolean => context.measured !== false

export type FooterReadout = {
  full: boolean
  text: string
  meters: readonly FooterMeter[]
}

export function meterText(meter: FooterMeter): string {
  return `${meter.label} ${meter.text}`
}

export type FooterInstruments = {
  items: readonly FooterItem[]
  context: FooterReadout | null
}

export type FooterLayout = {
  instruments: FooterInstruments
  instrumentCells: number
}

export function readouts(context: FooterContext): readonly FooterReadout[] {
  const percent = `${Math.round(context.percent)}%`
  const meters = context.meters ?? []

  /**
   * A window nothing measured is a standing condition, not a reading, so the slot says so rather
   * than going blank — an absent meter reads as a layout choice and a zero reads as real data.
   */
  if (!isMeasured(context)) {
    const spelled = `${glyph.warning} ${UNMEASURED_CONTEXT}`
    return [
      ...(meters.length === 0 ? [] : [{ full: true, text: spelled, meters }]),
      { full: true, text: spelled, meters: [] },
      { full: false, text: UNMEASURED_CONTEXT, meters: [] },
    ]
  }

  if (isContextWarning(context.percent)) {
    const spelled = `context ${percent} — ${COMPACT_COMMAND} to compact`
    return [
      ...(meters.length === 0 ? [] : [{ full: true, text: spelled, meters }]),
      { full: true, text: spelled, meters: [] },
      { full: false, text: spelled, meters: [] },
      { full: false, text: `context ${percent}`, meters: [] },
      { full: false, text: percent, meters: [] },
    ]
  }

  const used = context.tokensUsed === undefined ? null : formatTokens(context.tokensUsed)
  const head = used === null ? percent : `${used} ${percent}`
  const withMeters = meters.map((unused, index) => ({
    full: true,
    text: head,
    meters: meters.slice(0, meters.length - index),
  }))

  return [
    ...withMeters,
    ...(used === null ? [] : [{ full: true, text: head, meters: [] }]),
    { full: false, text: percent, meters: [] },
  ]
}

export function readoutCells(args: { readout: FooterReadout }): number {
  const meters = args.readout.meters.reduce(
    (total, meter) => total + 1 + cellsOf(meterText(meter)),
    0,
  )

  return cellsOf(args.readout.text) + meters
}

const CHIP_GAP_CELLS = 1

/**
 * The chips sit a single space apart and the read-out trails at the far edge; what separates the
 * strip from the figures is the flexible gap between them, not a glyph.
 */
export function instrumentCells(args: { instruments: FooterInstruments }): number {
  const { items, context } = args.instruments

  const itemsCells =
    items.reduce((total, item) => total + footerItemCells(item), 0) +
    Math.max(0, items.length - 1) * CHIP_GAP_CELLS

  const contextCells = context === null ? 0 : readoutCells({ readout: context })

  return itemsCells + contextCells
}

const BARE: FooterInstruments = {
  items: NO_FOOTER_ITEMS,
  context: null,
}

/**
 * Items hang off the widest read-out rung alone, so the row sheds every pill before the read-out
 * degrades a step. A read-out that is still spelling out a warning is why the footer is worth
 * reading at all, so nothing outranks it; the narrower forms never carry a pill.
 */
function dropLadder(args: {
  items: readonly FooterItem[]
  context: FooterContext | null
}): readonly FooterInstruments[] {
  const forms: readonly (FooterReadout | null)[] =
    args.context === null ? [null] : readouts(args.context)
  const [widest, ...narrower] = forms

  return [
    ...itemLadder(args.items).map((items) => ({ items, context: widest ?? null })),
    ...narrower.map((context) => ({ items: NO_FOOTER_ITEMS, context })),
    BARE,
  ]
}

export function footerLayout(args: {
  width: number
  items?: readonly FooterItem[]
  context?: FooterContext | null
}): FooterLayout {
  const inner = Math.max(0, args.width - FOOTER_GUTTER * 2)

  const ladder = dropLadder({
    items: args.items ?? NO_FOOTER_ITEMS,
    context: args.context ?? null,
  })
  const cellsFor = (instruments: FooterInstruments): number => instrumentCells({ instruments })

  const instruments = ladder.find((entry) => cellsFor(entry) <= inner) ?? BARE

  return { instruments, instrumentCells: cellsFor(instruments) }
}
