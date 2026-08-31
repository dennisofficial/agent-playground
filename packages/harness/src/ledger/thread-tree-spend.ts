import type { ThreadTreeSpend, TurnSpend } from './turn-ledger.port'

export type SpendTotals = {
  turns: number
  steps: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export type ThreadTreeTotals = {
  own: SpendTotals
  delegated: SpendTotals
  combined: SpendTotals
}

export const NOTHING_SPENT: SpendTotals = {
  turns: 0,
  steps: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
}

const plus = ({ left, right }: { left: SpendTotals; right: SpendTotals }): SpendTotals => ({
  turns: left.turns + right.turns,
  steps: left.steps + right.steps,
  inputTokens: left.inputTokens + right.inputTokens,
  outputTokens: left.outputTokens + right.outputTokens,
  cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
  cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
})

const asTotals = (row: TurnSpend): SpendTotals => ({
  turns: 1,
  steps: row.steps,
  inputTokens: row.inputTokens,
  outputTokens: row.outputTokens,
  cacheReadTokens: row.cacheReadTokens,
  cacheWriteTokens: row.cacheWriteTokens,
})

export const totalSpend = (rows: readonly TurnSpend[]): SpendTotals =>
  rows.reduce((running, row) => plus({ left: running, right: asTotals(row) }), NOTHING_SPENT)

export function tallyThreadTreeSpend(spend: ThreadTreeSpend): ThreadTreeTotals {
  const own = totalSpend(spend.own)
  const delegated = totalSpend(spend.delegated)
  return { own, delegated, combined: plus({ left: own, right: delegated }) }
}
