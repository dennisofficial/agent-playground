import { ESeverity, type ERiskDimension } from './dimension'

export enum EClassifierMode {
  Off = 'off',
  Shadow = 'shadow',
  Nudge = 'nudge',
}

export enum ETriage {
  Clear = 'clear',
  Consult = 'consult',
}

export type ClassifierPolicy = {
  mode: EClassifierMode
  consultAtOrAbove: ESeverity
  askWhenUnreachableAtOrAbove: ESeverity
  asksPerThread: number
  muted: readonly ERiskDimension[]
}

export const DEFAULT_CLASSIFIER_POLICY: ClassifierPolicy = {
  mode: EClassifierMode.Shadow,
  consultAtOrAbove: ESeverity.Serious,
  askWhenUnreachableAtOrAbove: ESeverity.Grave,
  asksPerThread: 8,
  muted: [],
}
