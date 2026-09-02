import { EConsultation, ETriage, type EDeed } from '@dltech/atlas-core'
import type { ReplayReport, ReplayRow, ReplaySummary } from '@dltech/atlas-harness'

const NOTHING = '—'

const DEED_WIDTH = 34

const MISSES_ARE_A_GUESS =
  'misses are a HEURISTIC: a call that cleared, whose target the thread then undid. Read them as questions, not counts.'

const columns = ({
  cells,
  widths,
}: {
  cells: readonly string[]
  widths: readonly number[]
}): string =>
  cells
    .map((cell, index) => cell.padEnd(widths[index] ?? 0))
    .join('  ')
    .trimEnd()

const clipped = ({ text, width }: { text: string; width: number }): string =>
  text.length <= width ? text : `${text.slice(0, width - 1)}…`

const deedsOf = ({ deeds }: { deeds: readonly EDeed[] }): string =>
  deeds.length === 0 ? NOTHING : clipped({ text: [...new Set(deeds)].join(','), width: DEED_WIDTH })

function outcomeOf({ row }: { row: ReplayRow }): string {
  const judged = row.judged
  if (judged === undefined) return 'clear (shape)'
  if (judged.wouldAsk === true) return 'ASK'
  if (judged.fatigued === true) return 'clear (fatigue)'
  if (row.grantCleared) return 'clear (granted)'
  if (row.consultation === EConsultation.Judged) return 'clear (judge)'
  if (row.consultation === EConsultation.Budgeted) return 'clear (budget)'
  if (row.consultation === EConsultation.Unreachable) return 'clear (unreached)'
  if (judged.triage === ETriage.Consult) return 'consult (offline)'
  return 'clear (triage)'
}

const dimensionsOf = ({ row }: { row: ReplayRow }): string => {
  const judged = row.judged
  if (judged === undefined) return NOTHING
  const named = judged.judgedDimension === undefined ? judged.dimensions : [judged.judgedDimension]
  return named.length === 0 ? NOTHING : named.join(',')
}

const HEADINGS: readonly string[] = [
  'seq',
  'tool',
  'deeds',
  'outcome',
  'dimensions',
  'then',
  'undone',
]

const cellsFor = ({ row }: { row: ReplayRow }): readonly string[] => [
  String(row.seq),
  row.toolName,
  deedsOf({ deeds: row.deeds }),
  outcomeOf({ row }),
  dimensionsOf({ row }),
  row.askedThen ? 'asked' : NOTHING,
  row.undone?.kind ?? NOTHING,
]

function widthsFor({ rows }: { rows: readonly (readonly string[])[] }): readonly number[] {
  return HEADINGS.map((heading, index) =>
    rows.reduce((widest, cells) => Math.max(widest, cells[index]?.length ?? 0), heading.length),
  )
}

const rate = ({ summary }: { summary: ReplaySummary }): string => summary.asksPerTurn.toFixed(2)

function summaryLines({ summary }: { summary: ReplaySummary }): readonly string[] {
  return [
    `candidates    ${summary.calls} calls — ${summary.clearedByShape} cleared on shape alone, ${summary.weighed} weighed by the probes`,
    `judge         ${summary.consulted} consulted, ${summary.budgeted} past the turn budget, ${summary.unreachable} unreachable`,
    `grants        ${summary.clearedByGrant} weighed calls a standing grant already covered`,
    `pauses        ${summary.asks} over ${summary.turns} turns — ${rate({ summary })} per turn`,
    ...summary.pausesByDimension.map((entry) => `              ${entry.dimension} ${entry.count}`),
    `signals       ${summary.signalsByDimension.map((entry) => `${entry.dimension} ${entry.count}`).join(', ') || 'none fired'}`,
    `recorded run  ${summary.askedThen} of these calls actually asked the developer at the time`,
    `misses        ${summary.suspectedMisses} suspected`,
  ]
}

function missLines({ report }: { report: ReplayReport }): readonly string[] {
  const undone = report.rows.filter((row) => row.undone !== undefined)
  if (undone.length === 0) return ['no cleared call in this thread was visibly undone.']

  return undone.map(
    (row) => `  seq ${row.seq} ${row.toolName} — ${row.undone?.kind}: ${row.undone?.detail}`,
  )
}

export function replayLines({
  report,
  summary,
  misses,
}: {
  report: ReplayReport
  summary: ReplaySummary
  misses: boolean
}): readonly string[] {
  const cells = report.rows.map((row) => cellsFor({ row }))
  const widths = widthsFor({ rows: cells })

  return [
    `thread ${report.threadId} — replayed against the probes as they stand now,`,
    `as if it had run in ${report.projectDirectory}, over the workspace as it is today.`,
    '',
    columns({ cells: HEADINGS, widths }),
    ...cells.map((row) => columns({ cells: row, widths })),
    '',
    ...summaryLines({ summary }),
    '',
    MISSES_ARE_A_GUESS,
    ...(misses ? missLines({ report }) : []),
  ]
}
