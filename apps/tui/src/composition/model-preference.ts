import {
  choiceValueOf,
  clampEffort,
  DEFAULT_EFFORT,
  EFFORT_LADDER,
  ESettingId,
  parseRef,
  refKey,
  textValueOf,
  type EEffort,
  type ModelRef,
  type SettingsResolution,
} from '@dltech/atlas-core'
import type { SettingsService } from '@dltech/atlas-harness'

import { DEFAULT_MODEL_REF } from './config'
import type { ModelSelection } from './model-selection'
import { isRefReachable, type ModelCatalogue } from './providers'

const settledRef = (args: {
  resolution: SettingsResolution
  catalogue: ModelCatalogue
}): ModelRef | undefined => {
  const held = textValueOf({ resolution: args.resolution, id: ESettingId.ModelId })
  return usableRef({ reference: held, catalogue: args.catalogue })
}

const usableRef = (args: {
  reference: string | undefined
  catalogue: ModelCatalogue
}): ModelRef | undefined => {
  if (args.reference === undefined || args.reference.length === 0) return undefined

  const ref = parseRef(args.reference)
  if (ref === undefined) return undefined

  return isRefReachable({ catalogue: args.catalogue, ref }) ? ref : undefined
}

const settledEffort = (resolution: SettingsResolution): EEffort | undefined => {
  const held = choiceValueOf({ resolution, id: ESettingId.ModelEffort, fallback: DEFAULT_EFFORT })
  return EFFORT_LADDER.find((effort) => effort === held)
}

/**
 * A model named on the command line is an override for that launch, so it outranks the pair the
 * switcher last wrote — which the layers have already merged with the project file and the
 * environment by the time this reads them.
 */
export function launchSelection(args: {
  requested: { model: string | undefined }
  settled: SettingsResolution
  catalogue: ModelCatalogue
}): ModelSelection {
  const ref =
    usableRef({ reference: args.requested.model, catalogue: args.catalogue }) ??
    settledRef({ resolution: args.settled, catalogue: args.catalogue }) ??
    DEFAULT_MODEL_REF

  const asked = settledEffort(args.settled) ?? DEFAULT_EFFORT
  const offered = args.catalogue.cardFor(ref)?.effort

  return { ref, effort: clampEffort({ map: offered, effort: asked }) ?? asked }
}

export function rememberSelection(args: {
  settings: SettingsService
  selection: ModelSelection
}): void {
  args.settings.set({ id: ESettingId.ModelId, value: refKey(args.selection.ref) })
  args.settings.set({ id: ESettingId.ModelEffort, value: args.selection.effort })
}
