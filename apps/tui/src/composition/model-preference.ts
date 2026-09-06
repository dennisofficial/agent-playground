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
import type { SettingsService, ThreadModel } from '@dltech/atlas-harness'

import { DEFAULT_MODEL_REF } from './config'
import type { ModelSelection } from './model-selection'
import { isRefReachable, type ModelCatalogue } from './providers'

const usableRef = (args: {
  reference: string | undefined
  catalogue: ModelCatalogue
}): ModelRef | undefined => {
  if (args.reference === undefined || args.reference.length === 0) return undefined

  const ref = parseRef(args.reference)
  if (ref === undefined) return undefined

  return isRefReachable({ catalogue: args.catalogue, ref }) ? ref : undefined
}

const usableEffort = (held: string | undefined): EEffort | undefined =>
  EFFORT_LADDER.find((effort) => effort === held)

const settled = (args: {
  ref: ModelRef
  effort: EEffort
  catalogue: ModelCatalogue
}): ModelSelection => ({
  ref: args.ref,
  effort:
    clampEffort({ map: args.catalogue.cardFor(args.ref)?.effort, effort: args.effort }) ??
    args.effort,
})

/** The pair a conversation with no model of its own starts on, as the layers settled it. */
export function defaultSelection(args: {
  settled: SettingsResolution
  catalogue: ModelCatalogue
}): ModelSelection {
  const reference = textValueOf({ resolution: args.settled, id: ESettingId.ModelId })
  const effort = choiceValueOf({
    resolution: args.settled,
    id: ESettingId.ModelEffort,
    fallback: DEFAULT_EFFORT,
  })

  return settled({
    ref: usableRef({ reference, catalogue: args.catalogue }) ?? DEFAULT_MODEL_REF,
    effort: usableEffort(effort) ?? DEFAULT_EFFORT,
    catalogue: args.catalogue,
  })
}

/**
 * A model named on the command line is an override for that launch, so it outranks both the default
 * the settings hold and whatever the thread it lands on was last switched to.
 */
export function launchSelection(args: {
  requested: { model: string | undefined }
  settled: SettingsResolution
  catalogue: ModelCatalogue
}): ModelSelection {
  const asked = usableRef({ reference: args.requested.model, catalogue: args.catalogue })
  const fallback = defaultSelection({ settled: args.settled, catalogue: args.catalogue })
  if (asked === undefined) return fallback

  return settled({ ref: asked, effort: fallback.effort, catalogue: args.catalogue })
}

/** Whether a launch is pinned to one model, in which case the thread it opens does not get a say. */
export const modelPinned = (args: {
  requested: { model: string | undefined }
  catalogue: ModelCatalogue
}): boolean =>
  usableRef({ reference: args.requested.model, catalogue: args.catalogue }) !== undefined

/**
 * A thread that names a model nobody can answer for — one that left the catalogue, or whose account
 * is gone — falls back whole rather than in halves, so the effort never outlives its model.
 */
export function threadSelection(args: {
  stored: ThreadModel | undefined
  fallback: ModelSelection
  catalogue: ModelCatalogue
}): ModelSelection {
  const ref = usableRef({ reference: args.stored?.ref, catalogue: args.catalogue })
  if (ref === undefined) return args.fallback

  return settled({
    ref,
    effort: usableEffort(args.stored?.effort) ?? args.fallback.effort,
    catalogue: args.catalogue,
  })
}

export const storedModel = (selection: ModelSelection): ThreadModel => ({
  ref: refKey(selection.ref),
  effort: selection.effort,
})

/** The model a Model-kind setting already names, if it still resolves against the catalogue. */
export function settingModelRef(args: {
  id: string
  settled: SettingsResolution
  catalogue: ModelCatalogue
}): ModelRef | undefined {
  return usableRef({
    reference: textValueOf({ resolution: args.settled, id: args.id }),
    catalogue: args.catalogue,
  })
}

/**
 * A switcher pick lands on the Model-kind row it was opened from. Only the Default model row
 * carries an effort beside it; the quick-call model pins its effort where it is used instead.
 */
export function rememberSettingModel(args: {
  settings: SettingsService
  target: { id: string; withEffort: boolean }
  selection: ModelSelection
}): void {
  args.settings.set({ id: args.target.id, value: refKey(args.selection.ref) })
  if (!args.target.withEffort) return
  args.settings.set({ id: ESettingId.ModelEffort, value: args.selection.effort })
}
