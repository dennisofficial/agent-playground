import { type SettingDefinition } from './definition'
import { ESettingKind, type SettingValue } from './value'

const wrapped = (args: { index: number; length: number }): number => {
  if (args.length === 0) return 0
  return ((args.index % args.length) + args.length) % args.length
}

const clamped = (args: { value: number; minimum: number; maximum: number }): number =>
  Math.min(args.maximum, Math.max(args.minimum, args.value))

const optionIndex = (args: { options: readonly { value: string }[]; value: SettingValue }): number => {
  const found = args.options.findIndex((option) => option.value === args.value)
  return found < 0 ? 0 : found
}

export function activateSetting(args: {
  definition: SettingDefinition
  current: SettingValue
}): SettingValue {
  const { definition, current } = args

  if (definition.kind === ESettingKind.Toggle) {
    return typeof current === 'boolean' ? !current : !definition.fallback
  }

  if (definition.kind === ESettingKind.Text || definition.kind === ESettingKind.Secret) {
    return typeof current === 'string' ? current : definition.fallback
  }

  if (definition.kind === ESettingKind.Choice) {
    const next = wrapped({
      index: optionIndex({ options: definition.options, value: current }) + 1,
      length: definition.options.length,
    })
    return definition.options[next]?.value ?? definition.fallback
  }

  const held = typeof current === 'number' ? current : definition.fallback
  const advanced = held + definition.step
  return advanced > definition.maximum ? definition.minimum : advanced
}

export function adjustSetting(args: {
  definition: SettingDefinition
  current: SettingValue
  delta: number
}): SettingValue {
  const { definition, current } = args
  const delta = Math.trunc(args.delta)

  if (definition.kind === ESettingKind.Toggle) {
    if (delta === 0) return typeof current === 'boolean' ? current : definition.fallback
    return delta > 0
  }

  if (definition.kind === ESettingKind.Text || definition.kind === ESettingKind.Secret) {
    return typeof current === 'string' ? current : definition.fallback
  }

  if (definition.kind === ESettingKind.Choice) {
    const target = clamped({
      value: optionIndex({ options: definition.options, value: current }) + delta,
      minimum: 0,
      maximum: definition.options.length - 1,
    })
    return definition.options[target]?.value ?? definition.fallback
  }

  const held = typeof current === 'number' ? current : definition.fallback
  return clamped({
    value: held + delta * definition.step,
    minimum: definition.minimum,
    maximum: definition.maximum,
  })
}
