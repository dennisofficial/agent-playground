import { coerceSettingValue } from './coerce'
import { type SettingDefinition } from './definition'
import {
  DEFAULT_LAYER_ORIGIN,
  ESettingsLayer,
  layerPrecedence,
  type SettingsLayerInput,
} from './layers'
import { type SettingValue } from './value'

export type ResolvedSetting = {
  definition: SettingDefinition
  value: SettingValue
  layer: ESettingsLayer
  origin: string
}

export type SettingRejection = {
  id: string
  layer: ESettingsLayer
  origin: string
  reason: string
}

export type SettingsResolution = {
  settings: ReadonlyMap<string, ResolvedSetting>
  rejected: readonly SettingRejection[]
}

const UNKNOWN_SETTING = 'not a setting Atlas knows'

export function resolveSettings(args: {
  definitions: readonly SettingDefinition[]
  layers: readonly SettingsLayerInput[]
}): SettingsResolution {
  const settings = new Map<string, ResolvedSetting>()
  const rejected: SettingRejection[] = []

  for (const definition of args.definitions) {
    settings.set(definition.id, {
      definition,
      value: definition.fallback,
      layer: ESettingsLayer.Default,
      origin: DEFAULT_LAYER_ORIGIN,
    })
  }

  const ordered = [...args.layers].sort(
    (left, right) => layerPrecedence(left.layer) - layerPrecedence(right.layer),
  )

  for (const layer of ordered) {
    for (const [id, raw] of Object.entries(layer.values)) {
      const origin = layer.origins?.[id] ?? layer.origin
      const held = settings.get(id)

      if (held === undefined) {
        rejected.push({ id, layer: layer.layer, origin, reason: UNKNOWN_SETTING })
        continue
      }

      const coerced = coerceSettingValue({ definition: held.definition, raw })
      if (!coerced.ok) {
        rejected.push({ id, layer: layer.layer, origin, reason: coerced.reason })
        continue
      }

      settings.set(id, {
        definition: held.definition,
        value: coerced.value,
        layer: layer.layer,
        origin,
      })
    }
  }

  return { settings, rejected }
}

export function toggleValueOf(args: { resolution: SettingsResolution; id: string }): boolean {
  const held = args.resolution.settings.get(args.id)
  return typeof held?.value === 'boolean' ? held.value : false
}

export function choiceValueOf(args: {
  resolution: SettingsResolution
  id: string
  fallback: string
}): string {
  const held = args.resolution.settings.get(args.id)
  return typeof held?.value === 'string' ? held.value : args.fallback
}

export function rangeValueOf(args: {
  resolution: SettingsResolution
  id: string
  fallback: number
}): number {
  const held = args.resolution.settings.get(args.id)
  return typeof held?.value === 'number' ? held.value : args.fallback
}
