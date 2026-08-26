import {
  ECallState,
  EGroupState,
  type CallTotals,
  type ToolCallRow,
  type ToolGroup,
} from '../store'
import type { Span } from './components/spans'
import { cellsOf } from './hint-layout'
import { formatElapsed, theme } from './theme'
import { affordanceFor, toneColour } from './tool-verbs'

const MINUS = '−'

const ELLIPSIS = '…'

const SEPARATOR = ' · '

export const INDENT = '    '

export const GAP = 1

const DIRECTORIES_SHOWN = 2

const ELAPSED_FLOOR_MS = 1_000

export const spanCells = (spans: readonly Span[]): number =>
  spans.reduce((total, span) => total + cellsOf(span.text), 0)

export function fitSpans(args: { spans: readonly Span[]; cells: number }): Span[] {
  const kept: Span[] = []
  let used = 0

  for (const span of args.spans) {
    const room = args.cells - used
    if (room <= 0) break

    const glyphs = [...span.text]
    if (glyphs.length <= room) {
      kept.push(span)
      used += glyphs.length
      continue
    }

    kept.push({ ...span, text: `${glyphs.slice(0, Math.max(0, room - 1)).join('')}${ELLIPSIS}` })
    break
  }

  return kept
}

function joined(parts: readonly (readonly Span[])[]): Span[] {
  return parts
    .filter((part) => part.length > 0)
    .flatMap((part, index) =>
      index === 0 ? [...part] : [{ text: SEPARATOR, fg: theme.rule }, ...part],
    )
}

function diffSpans(totals: Pick<CallTotals, 'added' | 'removed'>): Span[] {
  const spans: Span[] = []
  if (totals.added !== null) spans.push({ text: `+${totals.added}`, fg: theme.ok })
  if (totals.removed === null) return spans

  if (spans.length > 0) spans.push({ text: ' ' })
  spans.push({ text: `${MINUS}${totals.removed}`, fg: theme.error })
  return spans
}

const directoryOf = (target: string): string => {
  const cut = target.lastIndexOf('/')
  return cut <= 0 ? target : target.slice(0, cut)
}

function directorySpans(args: { group: ToolGroup; cells: number }): Span[] {
  const targets = args.group.calls
    .map((call) => call.target)
    .filter((target): target is string => target !== null)

  const directories = [...new Set(targets.map(directoryOf))].slice(0, DIRECTORIES_SHOWN)
  if (directories.length === 0) return []

  return fitSpans({ spans: [{ text: directories.join(', '), fg: theme.hint }], cells: args.cells })
}

export function elapsedSpans(args: { group: ToolGroup; now: number }): Span[] {
  const started = args.group.startedAtMs
  if (started === null) return []

  const elapsed = (args.group.settledAtMs ?? args.now) - started
  if (elapsed < ELAPSED_FLOOR_MS) return []

  return [{ text: formatElapsed(elapsed), fg: theme.hint }]
}

function countedSpans(args: { group: ToolGroup; cells: number }): Span[] {
  const diff = diffSpans(args.group.totals)
  if (diff.length > 0) return diff

  const passed = args.group.totals.passed
  if (passed !== null) return [{ text: `${passed} pass`, fg: theme.hint }]

  return directorySpans(args)
}

export function settledDetail(args: {
  group: ToolGroup
  now: number
  inner: number
  expandable: boolean
  expanded: boolean
}): Span[] {
  const affordance =
    args.expandable && !args.expanded
      ? [{ text: affordanceFor(args.group.verb), fg: theme.hint }]
      : []

  return joined([
    countedSpans({ group: args.group, cells: Math.floor(args.inner / 2) }),
    elapsedSpans({ group: args.group, now: args.now }),
    affordance,
  ])
}

export function itemDetail(row: ToolCallRow): Span[] {
  if (row.state === ECallState.Denied) return [{ text: row.note ?? 'denied', fg: theme.warn }]
  if (row.state === ECallState.Failed) return [{ text: row.note ?? 'failed', fg: theme.error }]
  if (row.state === ECallState.Pending) return []

  return joined([
    row.totals.created ? [{ text: 'new', fg: theme.ok }] : [],
    diffSpans(row.totals),
    row.totals.passed === null ? [] : [{ text: `${row.totals.passed} pass`, fg: theme.hint }],
    row.totals.lines === null ? [] : [{ text: String(row.totals.lines), fg: theme.hint }],
  ])
}

export const nameOf = (row: ToolCallRow): string => row.target ?? row.name

export const railColour = (group: ToolGroup): string =>
  group.state === EGroupState.Failed ? theme.error : toneColour(group.verb.tone)
