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
 * Everything on the row is a single space apart — facts, chips, the read-out and its meters. The
 * one separator dot left is the one between the facts and the chips, marking where the
 * instruments end and the pressable row begins.
 */
export function instrumentCells(args: { instruments: FooterInstruments }): number {
  const { model, effort, items, context } = args.instruments

  const facts = [
    ...(model === null ? [] : [cellsOf(model)]),
    ...(effort === null ? [] : [cellsOf(effort)]),
  ]
  const factsCells =
    facts.reduce((total, cells) => total + cells, 0) + Math.max(0, facts.length - 1)

  const itemsCells =
    items.reduce((total, item) => total + footerItemCells(item), 0) +
    Math.max(0, items.length - 1) * CHIP_GAP_CELLS

  const lead = factsCells > 0 && items.length > 0 ? cellsOf(HINT_SEPARATOR) : 0
  const contextCells = context === null ? 0 : readoutCells({ readout: context })

  return factsCells + lead + itemsCells + contextCells
}

type Facts = { model: string; effort: string | null }

const BARE: FooterInstruments = {
  model: null,
  effort: null,
  items: NO_FOOTER_ITEMS,
  context: null,
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
    ...kept.map((context) => ({ ...args.facts, items, context })),
    { model: args.facts.model, effort: null, items, context: narrowest },
    { model: null, effort: null, items, context: narrowest },
    ...shortened.map((context) => ({ model: null, effort: null, items, context })),
    BARE,
  ]
}

/**
 * Items hang off the widest rung alone, so the row sheds every pill before any instrument degrades.
 * The model is therefore always spelled beside a pill and the renderer never has to draw a leading
 * item; the effort and the read-out ride along only when the caller supplied them at all.
 */
function dropLadder(args: {
  facts: Facts
  items: readonly FooterItem[]
  context: FooterContext | null
}): readonly FooterInstruments[] {
  const rungs = instrumentLadder({ facts: args.facts, context: args.context })
  const [widest, ...narrower] = rungs
  if (widest === undefined) return [BARE]

  return [
    ...itemLadder(args.items).map((items) => ({ ...widest, items })),
    ...narrower.map((instruments) => ({ ...instruments, items: NO_FOOTER_ITEMS })),
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
