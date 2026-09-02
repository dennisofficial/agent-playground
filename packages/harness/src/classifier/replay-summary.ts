import { EConsultation, ETriage, type ERiskDimension } from '@dltech/atlas-core'

import type { ReplayReport, ReplayRow } from './replay'

export type DimensionCount = { dimension: ERiskDimension; count: number }

export type ReplaySummary = {
  turns: number
  calls: number
  clearedByShape: number
  weighed: number
  clearedByGrant: number
  consulted: number
  budgeted: number
  unreachable: number
  asks: number
  asksPerTurn: number
  askedThen: number
  suspectedMisses: number
  pausesByDimension: readonly DimensionCount[]
  signalsByDimension: readonly DimensionCount[]
}

const weighedRows = (rows: readonly ReplayRow[]): readonly ReplayRow[] =>
  rows.filter((row) => row.judged !== undefined)

const asking = (row: ReplayRow): boolean => row.judged?.wouldAsk === true

const dimensionsOf = (row: ReplayRow): readonly ERiskDimension[] => {
  const judged = row.judged
  if (judged === undefined) return []
  return judged.judgedDimension === undefined ? judged.dimensions : [judged.judgedDimension]
}

function tally({ rows }: { rows: readonly ReplayRow[] }): readonly DimensionCount[] {
  const counts = new Map<ERiskDimension, number>()
  for (const row of rows) {
    for (const dimension of dimensionsOf(row)) {
      counts.set(dimension, (counts.get(dimension) ?? 0) + 1)
    }
  }

  return [...counts]
    .map(([dimension, count]) => ({ dimension, count }))
    .sort((one, other) => other.count - one.count || one.dimension.localeCompare(other.dimension))
}

const per = ({ asks, turns }: { asks: number; turns: number }): number =>
  turns === 0 ? asks : asks / turns

export function summarise({ report }: { report: ReplayReport }): ReplaySummary {
  const rows = report.rows
  const weighed = weighedRows(rows)
  const asks = rows.filter(asking)

  return {
    turns: report.turns,
    calls: report.calls,
    clearedByShape: rows.length - weighed.length,
    weighed: weighed.length,
    clearedByGrant: weighed.filter((row) => row.grantCleared).length,
    consulted: weighed.filter((row) => row.consultation === EConsultation.Judged).length,
    budgeted: weighed.filter((row) => row.consultation === EConsultation.Budgeted).length,
    unreachable: weighed.filter((row) => row.consultation === EConsultation.Unreachable).length,
    asks: asks.length,
    asksPerTurn: per({ asks: asks.length, turns: report.turns }),
    askedThen: rows.filter((row) => row.askedThen).length,
    suspectedMisses: rows.filter((row) => row.undone !== undefined).length,
    pausesByDimension: tally({ rows: asks }),
    signalsByDimension: tally({
      rows: weighed.filter((row) => row.judged?.triage === ETriage.Consult),
    }),
  }
}
