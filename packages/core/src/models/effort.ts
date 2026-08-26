import { EEffort } from './catalog'

export const EFFORT_ORDER: readonly EEffort[] = [EEffort.Low, EEffort.Medium, EEffort.High]

const THINKING_BUDGETS: Record<EEffort, number> = {
  [EEffort.Low]: 1024,
  [EEffort.Medium]: 2048,
  [EEffort.High]: 16_384,
}

export function thinkingBudgetFor(effort: EEffort): number {
  return THINKING_BUDGETS[effort]
}

export function nextEffort(args: { effort: EEffort; delta: number }): EEffort {
  const index = EFFORT_ORDER.indexOf(args.effort)
  if (index < 0) return args.effort

  const target = Math.min(EFFORT_ORDER.length - 1, Math.max(0, index + Math.trunc(args.delta)))
  return EFFORT_ORDER[target] ?? args.effort
}
