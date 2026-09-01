import { EEffort, EFFORT_LADDER } from '@dltech/atlas-core'
import type { ModelsDevModel } from './models-dev'

export enum EEffortShape {
  Literals = 'literals',
  Budget = 'budget',
  Unmapped = 'unmapped',
  None = 'none',
}

export type EffortDerivation = {
  shape: EEffortShape
  rungs?: Record<string, string | number>
}

const MODELS_DEV_OFF = 'none'

const THINKING_BUDGETS: readonly (readonly [EEffort, number])[] = [
  [EEffort.Low, 1024],
  [EEffort.Medium, 2048],
  [EEffort.High, 16_384],
]

function literalRungs(values: readonly (string | null)[]): Record<string, string> | undefined {
  const offered = new Set(values.filter((value): value is string => value !== null))

  const rungs: Record<string, string> = {}
  for (const rung of EFFORT_LADDER) {
    const wire = rung === EEffort.Off ? MODELS_DEV_OFF : rung
    if (offered.has(wire)) rungs[rung] = wire
  }

  return Object.keys(rungs).length === 0 ? undefined : rungs
}

function clampBudget({
  budget,
  min,
  max,
}: {
  budget: number
  min: number | undefined
  max: number | undefined
}): number {
  const lifted = min === undefined ? budget : Math.max(budget, min)
  return max === undefined ? lifted : Math.min(lifted, max)
}

function budgetRungs({
  min,
  max,
}: {
  min: number | undefined
  max: number | undefined
}): Record<string, number> | undefined {
  const rungs: Record<string, number> = {}
  let previous: number | undefined

  for (const [rung, budget] of THINKING_BUDGETS) {
    const clamped = clampBudget({ budget, min, max })
    if (clamped === previous) continue

    rungs[rung] = clamped
    previous = clamped
  }

  return Object.keys(rungs).length === 0 ? undefined : rungs
}

export function deriveEffort(model: ModelsDevModel): EffortDerivation {
  if (model.reasoning !== true) return { shape: EEffortShape.None }

  const options = model.reasoning_options
  if (options === undefined || options.length === 0) return { shape: EEffortShape.None }

  const literals = options.find((option) => option.type === 'effort')
  if (literals !== undefined) {
    const rungs = literalRungs(literals.values ?? [])
    if (rungs === undefined) return { shape: EEffortShape.Unmapped }
    return { shape: EEffortShape.Literals, rungs }
  }

  const budget = options.find((option) => option.type === 'budget_tokens')
  if (budget !== undefined) {
    const rungs = budgetRungs({ min: budget.min, max: budget.max })
    if (rungs === undefined) return { shape: EEffortShape.Unmapped }
    return { shape: EEffortShape.Budget, rungs }
  }

  return { shape: EEffortShape.Unmapped }
}
