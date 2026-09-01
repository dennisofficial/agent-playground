import { NOTHING_SPENT, totalSpend, type SpendTotals, type TurnSpend } from '@dltech/atlas-harness'

export { NOTHING_SPENT, type SpendTotals }

export enum ESpendReading {
  Counted = 'counted',
  Unavailable = 'unavailable',
}

/**
 * The ledger refuses to answer rather than under-count, so a reading that never arrived has to stay
 * distinguishable from a reading of nothing: zero is a claim, and it is the wrong one.
 */
export type AgentSpend =
  { reading: ESpendReading.Counted; totals: SpendTotals } | { reading: ESpendReading.Unavailable }

export const NOTHING_COUNTED: AgentSpend = {
  reading: ESpendReading.Counted,
  totals: NOTHING_SPENT,
}

export const SPEND_UNAVAILABLE: AgentSpend = { reading: ESpendReading.Unavailable }

export const agentSpendOf = (rows: readonly TurnSpend[]): AgentSpend => ({
  reading: ESpendReading.Counted,
  totals: totalSpend(rows),
})
