import {
  ESettingsLayer,
  type SettingDefinition,
  type SettingsLayerInput,
} from '@dltech/atlas-core'

export const ENVIRONMENT_ORIGIN = 'environment'

export function environmentLayer(args: {
  definitions: readonly SettingDefinition[]
  env: Readonly<Record<string, string | undefined>>
}): SettingsLayerInput {
  const values: Record<string, string> = {}
  const origins: Record<string, string> = {}

  for (const definition of args.definitions) {
    const name = definition.environmentVariable
    if (name === undefined) continue

    const found = args.env[name]
    if (found === undefined || found.length === 0) continue

    values[definition.id] = found
    origins[definition.id] = name
  }

  return { layer: ESettingsLayer.Environment, origin: ENVIRONMENT_ORIGIN, values, origins }
}
