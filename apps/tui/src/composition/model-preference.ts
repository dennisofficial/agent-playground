import { EFFORT_ORDER, type EEffort, type SettingsDocument } from '@dltech/atlas-core'
import type { SettingsService } from '@dltech/atlas-harness'

import { DEFAULT_MODEL_ID, DEFAULT_THINKING_BUDGET_TOKENS } from './config'
import { effortOfBudget } from './effort-budget'
import { modelIsReachable, type ModelSelection } from './model-selection'

export const REMEMBERED_MODEL_ID = 'model.id'

export const REMEMBERED_EFFORT = 'model.effort'

const rememberedModelId = (document: SettingsDocument): string | undefined => {
  const held = document.values[REMEMBERED_MODEL_ID]
  return typeof held === 'string' && modelIsReachable(held) ? held : undefined
}

const rememberedEffort = (document: SettingsDocument): EEffort | undefined =>
  EFFORT_ORDER.find((effort) => effort === document.values[REMEMBERED_EFFORT])

/**
 * A model named on the command line or in the environment is an override for that launch, so it
 * outranks the pair the switcher last wrote — which in turn outranks what Atlas ships with.
 */
export function launchSelection(args: {
  requested: { modelId: string | undefined; thinkingBudgetTokens: number | undefined }
  remembered: SettingsDocument
}): ModelSelection {
  const budget = args.requested.thinkingBudgetTokens

  return {
    modelId: args.requested.modelId ?? rememberedModelId(args.remembered) ?? DEFAULT_MODEL_ID,
    effort:
      budget !== undefined
        ? effortOfBudget(budget)
        : (rememberedEffort(args.remembered) ?? effortOfBudget(DEFAULT_THINKING_BUDGET_TOKENS)),
  }
}

export function rememberSelection(args: {
  settings: SettingsService
  selection: ModelSelection
}): void {
  args.settings.set({ id: REMEMBERED_MODEL_ID, value: args.selection.modelId })
  args.settings.set({ id: REMEMBERED_EFFORT, value: args.selection.effort })
}
