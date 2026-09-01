import { refKey, type EEffort, type ModelRef } from '@dltech/atlas-core'
import { createSwitchableModel, type Switchable } from '@dltech/atlas-harness'

import { isRefReachable, type ModelCatalogue } from './providers'

export type ModelSelection = { ref: ModelRef; effort: EEffort }

/** What the app is allowed to know: which pair is answering, and how to change it. */
export type ModelChoice = {
  choice: () => ModelSelection
  select: (next: ModelSelection) => void
}

export type SelectableModel = Switchable<ModelSelection>

const unbuildable = (ref: ModelRef): Error =>
  new Error(`no provider adapter can answer for ${refKey(ref)}`)

export function selectableModel(args: {
  initial: ModelSelection
  catalogue: ModelCatalogue
  remember?: (choice: ModelSelection) => void
}): SelectableModel {
  let held = args.initial

  const switchable = createSwitchableModel<ModelSelection>({
    initial: args.initial,
    keyOf: (choice) => refKey(choice.ref),
    build: (choice) => {
      const card = args.catalogue.cardFor(choice.ref)
      const adapter = args.catalogue.adapterFor(choice.ref.providerId)
      if (card === undefined || adapter === undefined) throw unbuildable(choice.ref)

      return adapter.model({ card, effort: () => held.effort })
    },
  })

  return {
    ...switchable,
    select: (next) => {
      if (!isRefReachable({ catalogue: args.catalogue, ref: next.ref })) return

      held = next
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
