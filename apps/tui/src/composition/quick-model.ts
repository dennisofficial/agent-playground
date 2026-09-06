import {
  EEffort,
  ESettingId,
  EUtilityModelRole,
  refKey,
  resolveUtilityModel,
  textValueOf,
  type ModelRef,
} from '@dltech/atlas-core'
import {
  createNotifyingModel,
  type ProviderAdapter,
  type SettingsService,
} from '@dltech/atlas-harness'

import {
  ENoticeTone,
  NOTICE_KEY_QUICK_MODEL_PREFIX,
  NOTICE_WARN_MS,
  notify,
} from '../ui/notice-store'
import type { ModelCatalogue } from './providers'

type QuickLanguageModel = ReturnType<ProviderAdapter['model']>

const ROLE_LABEL: Readonly<Record<EUtilityModelRole, string>> = {
  [EUtilityModelRole.Tldr]: 'tl;dr footer',
  [EUtilityModelRole.Titler]: 'session titler',
  [EUtilityModelRole.Judge]: 'judge',
}

const faultMessageOf = (fault: unknown): string =>
  fault instanceof Error ? fault.message : String(fault)

/**
 * The role's ref is re-resolved on every call rather than subscribed to: the next quick call after
 * a settings write lands on the new model with nothing to tear down, and a model once built stays
 * cached under its ref so an outage's notice keys to the provider that actually failed.
 */
export function createQuickModel(args: {
  role: EUtilityModelRole
  settings: SettingsService
  catalogue: ModelCatalogue
}): QuickLanguageModel {
  const built = new Map<string, QuickLanguageModel>()

  const resolveRef = (): ModelRef =>
    resolveUtilityModel({
      role: args.role,
      override: textValueOf({
        resolution: args.settings.snapshot().resolution,
        id: ESettingId.QuickModel,
      }),
      catalogue: args.catalogue.catalog,
    })

  const current = (): QuickLanguageModel => {
    const ref = resolveRef()
    const key = refKey(ref)
    const held = built.get(key)
    if (held !== undefined) return held

    const card = args.catalogue.cardFor(ref)
    const adapter = args.catalogue.adapterFor(ref.providerId)
    if (card === undefined || adapter === undefined)
      throw new Error(`no provider adapter can answer for ${key}`)

    const model = createNotifyingModel({
      model: adapter.model({ card, effort: () => EEffort.Low }),
      onFault: (fault) =>
        notify({
          key: `${NOTICE_KEY_QUICK_MODEL_PREFIX}:${fault.providerId}`,
          tone: ENoticeTone.Warn,
          ttlMs: NOTICE_WARN_MS,
          text: `The ${ROLE_LABEL[args.role]} model ${fault.providerId}/${fault.modelId} failed: ${faultMessageOf(fault.fault)}`,
        }),
    })
    built.set(key, model)
    return model
  }

  return {
    specificationVersion: 'v4',
    get provider() {
      return current().provider
    },
    get modelId() {
      return current().modelId
    },
    get supportedUrls() {
      return current().supportedUrls
    },
    doGenerate: (options) => current().doGenerate(options),
    doStream: (options) => current().doStream(options),
  }
}
