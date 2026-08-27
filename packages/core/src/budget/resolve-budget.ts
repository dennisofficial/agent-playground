import type { Assembled } from '../assembly/assembled'
import { planCompaction, type CompactionPlan } from '../compaction/compaction-plan'
import { eventsWithCompaction } from '../compaction/preview'
import type { Event } from '../events/envelope'

export enum EBudgetVerdict {
  Fits = 'fits',
  Compact = 'compact',
  Exhausted = 'exhausted',
}

export type BudgetDecision =
  | { verdict: EBudgetVerdict.Fits; tokens: number }
  | { verdict: EBudgetVerdict.Compact; plan: CompactionPlan; tokens: number; projected: number }
  | { verdict: EBudgetVerdict.Exhausted; tokens: number }

export const DEFAULT_RECENCY_LADDER: readonly number[] = [
  60_000, 40_000, 25_000, 15_000, 8_000, 4_000, 2_000, 1_000,
]

export const SUMMARY_TOKEN_ALLOWANCE = 1_200

const placeholderSummary = (tokens: number): string => 'x'.repeat(tokens * 4)

type Rung = { plan: CompactionPlan; projected: number }

function measureRung({
  events,
  keepRecentTokens,
  summaryAllowance,
  assembleWith,
  countTokens,
}: {
  events: readonly Event[]
  keepRecentTokens: number
  summaryAllowance: number
  assembleWith: (events: readonly Event[]) => Assembled
  countTokens: (assembled: Assembled) => number
}): Rung | undefined {
  const plan = planCompaction({ events, keepRecentTokens })
  if (plan === undefined) return undefined

  const previewed = eventsWithCompaction({
    events,
    throughSeq: plan.throughSeq,
    summary: placeholderSummary(summaryAllowance),
  })

  return { plan, projected: countTokens(assembleWith(previewed)) }
}

export function resolveBudget({
  events,
  limit,
  assembleWith,
  countTokens,
  ladder = DEFAULT_RECENCY_LADDER,
  summaryAllowance = SUMMARY_TOKEN_ALLOWANCE,
}: {
  events: readonly Event[]
  limit: number
  assembleWith: (events: readonly Event[]) => Assembled
  countTokens: (assembled: Assembled) => number
  ladder?: readonly number[] | undefined
  summaryAllowance?: number | undefined
}): BudgetDecision {
  const tokens = countTokens(assembleWith(events))
  if (tokens <= limit) return { verdict: EBudgetVerdict.Fits, tokens }

  for (const keepRecentTokens of ladder) {
    const rung = measureRung({
      events,
      keepRecentTokens,
      summaryAllowance,
      assembleWith,
      countTokens,
    })
    if (rung !== undefined && rung.projected <= limit) {
      return { verdict: EBudgetVerdict.Compact, plan: rung.plan, tokens, projected: rung.projected }
    }
  }

  return { verdict: EBudgetVerdict.Exhausted, tokens }
}
