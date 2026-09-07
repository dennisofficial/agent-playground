import type { EEffort } from '@dltech/atlas-core'

import { COMPACT_COMMAND, isContextWarning } from './context-bar'
import { EFFORT_ABBREVIATION } from './effort-label'
import { footerItemCells, itemLadder, NO_FOOTER_ITEMS, type FooterItem } from './footer-item'
import { cellsOf, HINT_SEPARATOR } from './hint-layout'
import { formatTokens, glyph } from './theme'
import type { FooterMeter } from './usage-meters'

export const FOOTER_GUTTER = 1

export type FooterEffort = EEffort

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
  model: string | null
  effort: string | null
  items: readonly FooterItem[]
  context: FooterReadout | null
  rows: 1 | 2
}

export type FooterLayout = {
  instruments: FooterInstruments
  instrumentCells: number
}

export function effortSegment(effort: FooterEffort): string {
  return EFFORT_ABBREVIATION[effort]
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
 * Everything on a row is a single space apart — facts, chips, the read-out and its meters. The
 * one separator dot left is the one between the facts and the chips, marking where the
 * instruments end and the pressable row begins; it only exists when they share one.
 *
 * On two rows the facts and the read-out take the head and the chips take the tail, so the count
 * is the wider of the two rather than their sum.
 */
export function instrumentCells(args: { instruments: FooterInstruments }): number {
  const { model, effort, items, context, rows } = args.instruments

  const facts = [
    ...(model === null ? [] : [cellsOf(model)]),
    ...(effort === null ? [] : [cellsOf(effort)]),
  ]
  const factsCells =
    facts.reduce((total, cells) => total + cells, 0) + Math.max(0, facts.length - 1)

  const itemsCells =
    items.reduce((total, item) => total + footerItemCells(item), 0) +
    Math.max(0, items.length - 1) * CHIP_GAP_CELLS

  const contextCells = context === null ? 0 : readoutCells({ readout: context })

  if (rows === 2) return Math.max(factsCells + contextCells, itemsCells)

  const lead = factsCells > 0 && items.length > 0 ? cellsOf(HINT_SEPARATOR) : 0
  return factsCells + lead + itemsCells + contextCells
}

type Facts = { model: string; effort: string | null }

const BARE: FooterInstruments = {
  model: null,
  effort: null,
  items: NO_FOOTER_ITEMS,
  context: null,
  rows: 1,
}

/**
 * Widest first, each rung strictly narrower than the one above it: the read-out gives up its tail
 * and then its meter, then effort leaves, then the model. A read-out that is still spelling out a
 * warning outranks both facts — what it says is why the footer is worth reading at all — so the
 * forms are split at the first one that has dropped its meter, and the facts leave in between.
 */
function instrumentLadder(args: {
  facts: Facts
  context: FooterContext | null
}): readonly FooterInstruments[] {
  const forms = args.context === null ? [null] : readouts(args.context)
  const bareIndex = forms.findIndex((form) => form === null || !form.full)
  const kept = forms.slice(0, bareIndex + 1)
  const shortened = forms.slice(bareIndex + 1)
  const narrowest = kept[kept.length - 1] ?? null
  const items = NO_FOOTER_ITEMS

  return [
    ...kept.map((context) => ({ ...args.facts, items, context, rows: 1 as const })),
    { model: args.facts.model, effort: null, items, context: narrowest, rows: 1 as const },
    { model: null, effort: null, items, context: narrowest, rows: 1 as const },
    ...shortened.map((context) => ({
      model: null,
      effort: null,
      items,
      context,
      rows: 1 as const,
    })),
    BARE,
  ]
}

/**
 * One row while everything fits it; the moment it does not, the chips wrap to a row of their own
 * beneath the facts and the read-out rather than shedding one by one. The read-out degrades down
 * its forms while the chips all stay, and only a chip row too wide on its own sheds them, from
 * the tail. The single-row ladder without items is the fallback once there is nothing left to
 * wrap — the model is always spelled beside a pill, so the renderer never draws a leading one.
 */
function dropLadder(args: {
  facts: Facts
  items: readonly FooterItem[]
  context: FooterContext | null
}): readonly FooterInstruments[] {
  const rungs = instrumentLadder({ facts: args.facts, context: args.context })
  const [widest, ...narrower] = rungs
  if (widest === undefined) return [BARE]

  const forms: readonly (FooterReadout | null)[] =
    args.context === null ? [null] : readouts(args.context)

  const wrapped =
    args.items.length === 0
      ? []
      : [
          ...forms.map((context) => ({ ...widest, context, items: args.items, rows: 2 as const })),
          ...itemLadder(args.items)
            .slice(1)
            .filter((items) => items.length > 0)
            .map((items) => ({ ...widest, items, rows: 2 as const })),
        ]

  return [
    { ...widest, items: args.items, rows: 1 as const },
    ...wrapped,
    ...narrower,
  ]
}

export function footerLayout(args: {
  width: number
  model: string
  effort?: FooterEffort | null
  items?: readonly FooterItem[]
  context?: FooterContext | null
}): FooterLayout {
  const inner = Math.max(0, args.width - FOOTER_GUTTER * 2)
  const effort =
    args.effort === undefined || args.effort === null ? null : effortSegment(args.effort)

  const ladder = dropLadder({
    facts: { model: args.model, effort },
    items: args.items ?? NO_FOOTER_ITEMS,
    context: args.context ?? null,
  })
  const cellsFor = (instruments: FooterInstruments): number => instrumentCells({ instruments })

  const instruments = ladder.find((entry) => cellsFor(entry) <= inner) ?? BARE

  return { instruments, instrumentCells: cellsFor(instruments) }
}
