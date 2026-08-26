export enum ESettingsLayer {
  Default = 'default',
  User = 'user',
  Project = 'project',
  Environment = 'environment',
}

export const SETTINGS_LAYER_ORDER: readonly ESettingsLayer[] = [
  ESettingsLayer.Default,
  ESettingsLayer.User,
  ESettingsLayer.Project,
  ESettingsLayer.Environment,
]

export const DEFAULT_LAYER_ORIGIN = 'built in'

export type SettingsLayerInput = {
  layer: ESettingsLayer
  origin: string
  values: Readonly<Record<string, unknown>>
  origins?: Readonly<Record<string, string>>
}

export const layerPrecedence = (layer: ESettingsLayer): number =>
  SETTINGS_LAYER_ORDER.indexOf(layer)
