import { type EEffort, type ModelEntry, nextEffort } from '@dltech/atlas-core'

export type SwitcherAvailability = ReadonlySet<string> | ((modelId: string) => boolean)

export type SwitcherState = {
  index: number
  effort: EEffort
}

export type SwitcherChoice = {
  modelId: string | null
  effort: EEffort
}

export function isModelAvailable(args: {
  modelId: string
  availability?: SwitcherAvailability | undefined
}): boolean {
  const { availability } = args
  if (availability === undefined) return true
  if (typeof availability === 'function') return availability(args.modelId)
  return availability.has(args.modelId)
}

function selectableIndexes(args: {
  models: readonly ModelEntry[]
  availability?: SwitcherAvailability | undefined
}): number[] {
  return args.models.flatMap((entry, index) =>
    isModelAvailable({ modelId: entry.id, availability: args.availability }) ? [index] : [],
  )
}

export function openSwitcher(args: {
  models: readonly ModelEntry[]
  activeModelId: string
  effort: EEffort
  availability?: SwitcherAvailability | undefined
}): SwitcherState {
  const active = args.models.findIndex((entry) => entry.id === args.activeModelId)
  if (active >= 0) return { index: active, effort: args.effort }

  const [first] = selectableIndexes({ models: args.models, availability: args.availability })
  return { index: first ?? 0, effort: args.effort }
}

export function moveSelection(args: {
  state: SwitcherState
  delta: number
  models: readonly ModelEntry[]
  availability?: SwitcherAvailability | undefined
}): SwitcherState {
  const steps = Math.trunc(args.delta)
  const direction = Math.sign(steps)
  if (direction === 0) return args.state

  const selectable = selectableIndexes({ models: args.models, availability: args.availability })
  let index = args.state.index

  for (let taken = 0; taken < Math.abs(steps); taken += 1) {
    const next =
      direction > 0
        ? selectable.find((candidate) => candidate > index)
        : selectable.findLast((candidate) => candidate < index)
    if (next === undefined) break
    index = next
  }

  return { ...args.state, index }
}

export function adjustEffort(args: { state: SwitcherState; delta: number }): SwitcherState {
  return { ...args.state, effort: nextEffort({ effort: args.state.effort, delta: args.delta }) }
}

export function resolve(args: {
  state: SwitcherState
  models: readonly ModelEntry[]
}): SwitcherChoice {
  return { modelId: args.models[args.state.index]?.id ?? null, effort: args.state.effort }
}

export function priceLabel(entry: ModelEntry): string {
  return `$${entry.outputPricePerMillion.toFixed(2)}/M`
}
