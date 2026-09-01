import {
  BACKEND_TRAITS,
  backendOf,
  choiceValueOf,
  ESettingId,
  EWebSearchBackend,
  secretNameOf,
  type SettingsResolution,
} from '@dltech/atlas-core'

export type SecretTarget = {
  name: string
  label: string
  masked: boolean
  required: boolean
  takesOne: boolean
}

export function secretTargetOf(args: {
  id: string
  resolution: SettingsResolution
}): SecretTarget | undefined {
  if (args.id !== ESettingId.WebSearchKey) return undefined

  const chosen = choiceValueOf({
    resolution: args.resolution,
    id: ESettingId.WebSearchBackend,
    fallback: EWebSearchBackend.DuckDuckGo,
  })
  const traits = BACKEND_TRAITS[backendOf(chosen) ?? EWebSearchBackend.DuckDuckGo]

  return {
    name: secretNameOf(traits.backend),
    label: `${traits.label} ${traits.keyLabel ?? 'key'}`,
    masked: traits.masked,
    required: traits.keyRequired,
    takesOne: traits.keyLabel !== undefined,
  }
}
