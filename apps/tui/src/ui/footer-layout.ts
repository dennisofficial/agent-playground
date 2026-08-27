import { COMPACT_CHORD, CONTEXT_BAR_CELLS, isContextWarning } from './context-bar'
import { spellChord } from './keys'
import { cellsOf, HINT_SEPARATOR } from './hint-layout'
import { formatTokens } from './theme'

export const FOOTER_GUTTER = 3

export type FooterEffort = 'low' | 'medium' | 'high'

export type FooterContext = { percent: number; tokensLeft?: number }

export type FooterReadout = { bar: boolean; text: string }

export type FooterInstruments = {
  model: string | null
  effort: string | null
  context: FooterReadout | null
}

export type FooterLayout = {
  instruments: FooterInstruments
  instrumentCells: number
}

const EFFORT_LABEL: Record<FooterEffort, string> = { low: 'low', medium: 'med', high: 'high' }

export function effortSegment(effort: FooterEffort): string {
  return EFFORT_LABEL[effort]
}

export function readouts(context: FooterContext): readonly FooterReadout[] {
  const percent = `${Math.round(context.percent)}%`
  if (isContextWarning(context.percent)) {
    const spelled = `context ${percent} — ${spellChord(COMPACT_CHORD)} to compact`
    return [
      { bar: true, text: spelled },
      { bar: false, text: spelled },
      { bar: false, text: `context ${percent}` },
      { bar: false, text: percent },
    ]
  }
  const left = context.tokensLeft === undefined ? null : `${formatTokens(context.tokensLeft)} left`
  return [
    ...(left === null ? [] : [{ bar: true, text: `${percent}${HINT_SEPARATOR}${left}` }]),
    { bar: true, text: percent },
    { bar: false, text: percent },
  ]
}

export function readoutCells(args: { readout: FooterReadout; barCells: number }): number {
  return (args.readout.bar ? args.barCells + 1 : 0) + cellsOf(args.readout.text)
}

export function instrumentCells(args: {
  instruments: FooterInstruments
  barCells: number
}): number {
  const { model, effort, context } = args.instruments
  const segments = [
    ...(model === null ? [] : [cellsOf(model)]),
    ...(effort === null ? [] : [cellsOf(effort)]),
    ...(context === null ? [] : [readoutCells({ readout: context, barCells: args.barCells })]),
  ]
  if (segments.length === 0) return 0
  const spelled = segments.reduce((total, cells) => total + cells, 0)
  return spelled + (segments.length - 1) * cellsOf(HINT_SEPARATOR)
}

type Facts = { model: string; effort: string | null }

const BARE: FooterInstruments = { model: null, effort: null, context: null }

/**
 * Widest first, each rung strictly narrower than the one above it: the read-out gives up its tail
 * and then its meter, then effort leaves, then the model. A read-out that is still spelling out a
 * warning outranks both facts — what it says is why the footer is worth reading at all — so the
 * forms are split at the first one that has dropped its meter, and the facts leave in between.
 */
function dropLadder(args: {
  facts: Facts
  context: FooterContext | null
}): readonly FooterInstruments[] {
  const forms = args.context === null ? [null] : readouts(args.context)
  const bareIndex = forms.findIndex((form) => form === null || !form.bar)
  const kept = forms.slice(0, bareIndex + 1)
  const shortened = forms.slice(bareIndex + 1)
  const narrowest = kept[kept.length - 1] ?? null

  return [
    ...kept.map((context) => ({ ...args.facts, context })),
    { model: args.facts.model, effort: null, context: narrowest },
    { model: null, effort: null, context: narrowest },
    ...shortened.map((context) => ({ model: null, effort: null, context })),
    BARE,
  ]
}

export function footerLayout(args: {
  width: number
  model: string
  effort?: FooterEffort | null
  context?: FooterContext | null
  barCells?: number
}): FooterLayout {
  const barCells = args.barCells ?? CONTEXT_BAR_CELLS
  const inner = Math.max(0, args.width - FOOTER_GUTTER * 2)
  const effort = args.effort === undefined || args.effort === null ? null : effortSegment(args.effort)

  const ladder = dropLadder({
    facts: { model: args.model, effort },
    context: args.context ?? null,
  })
  const cellsFor = (instruments: FooterInstruments): number =>
    instrumentCells({ instruments, barCells })

  const instruments = ladder.find((entry) => cellsFor(entry) <= inner) ?? BARE

  return { instruments, instrumentCells: cellsFor(instruments) }
}
