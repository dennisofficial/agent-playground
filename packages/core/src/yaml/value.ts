export type YamlValue = string | readonly YamlValue[] | YamlMap

export type YamlMap = ReadonlyMap<string, YamlValue>

export const EMPTY_YAML_MAP: YamlMap = new Map()

export const isYamlMap = (value: YamlValue | undefined): value is YamlMap => value instanceof Map

export const isYamlList = (value: YamlValue | undefined): value is readonly YamlValue[] =>
  Array.isArray(value)

export const isYamlScalar = (value: YamlValue | undefined): value is string =>
  typeof value === 'string'
