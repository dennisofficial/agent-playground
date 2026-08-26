import {
  EEffort,
  EModelVendor,
  modelEntry,
  thinkingBudgetFor,
  type CredentialPort,
} from '@dltech/atlas-core'
import {
  createAnthropicOauthModel,
  createSwitchableModel,
  type Switchable,
} from '@dltech/atlas-harness'

export type ModelSelection = { modelId: string; effort: EEffort }

/** What the app is allowed to know: which pair is answering, and how to change it. */
export type ModelChoice = {
  choice: () => ModelSelection
  select: (next: ModelSelection) => void
}

export type SelectableModel = Switchable<ModelSelection>

/**
 * Only the Anthropic subscription credential is wired, so a model from another vendor is offered
 * and refused rather than hidden — which is the switcher's `⚠ no key` reading.
 */
export function modelIsReachable(modelId: string): boolean {
  return modelEntry(modelId)?.vendor === EModelVendor.Anthropic
}

export function selectableModel(args: {
  initial: ModelSelection
  credentials: CredentialPort
  remember?: (choice: ModelSelection) => void
}): SelectableModel {
  const switchable = createSwitchableModel<ModelSelection>({
    initial: args.initial,
    keyOf: (choice) => `${choice.modelId}:${choice.effort}`,
    build: (choice) =>
      createAnthropicOauthModel({
        credentials: args.credentials,
        modelId: choice.modelId,
        providerOptions: {
          anthropic: {
            thinking: { type: 'enabled', budgetTokens: thinkingBudgetFor(choice.effort) },
          },
        },
      }),
  })

  return {
    ...switchable,
    select: (next) => {
      if (!modelIsReachable(next.modelId)) return
      switchable.select(next)
      args.remember?.(next)
    },
  }
}

export function heldChoice(initial: ModelSelection): ModelChoice {
  let held = initial
  return {
    choice: () => held,
    select: (next) => {
      held = next
    },
  }
}
