import { EEffort, EFFORT_ORDER, thinkingBudgetFor } from '@dltech/atlas-core'

export function effortOfBudget(tokens: number): EEffort {
  const nearest = [...EFFORT_ORDER].sort(
    (left, right) =>
      Math.abs(thinkingBudgetFor(left) - tokens) - Math.abs(thinkingBudgetFor(right) - tokens),
  )
  return nearest[0] ?? EEffort.Medium
}
