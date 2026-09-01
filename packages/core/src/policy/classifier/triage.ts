import { ESeverity, type ERiskDimension } from './dimension'
import type { CallEvidence } from './evidence'
import { grantCovering, type Grant } from './grant'
import { reachesSeverity, type RiskSignal } from './signals'

export enum EClassifierMode {
  Off = 'off',
  Shadow = 'shadow',
  Nudge = 'nudge',
}

export const classifierModeOf = (value: string): EClassifierMode | undefined =>
  Object.values(EClassifierMode).find((mode) => mode === value)

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

export type ClearedSignal = { signal: RiskSignal; by: Grant }

export type Triage = {
  triage: ETriage
  standing: readonly RiskSignal[]
  cleared: readonly ClearedSignal[]
  fatigued: boolean
}

export function triageOf({
  evidence,
  signals,
  policy,
  asksSoFar,
}: {
  evidence: CallEvidence
  signals: readonly RiskSignal[]
  policy: ClassifierPolicy
  asksSoFar: number
}): Triage {
  const standing: RiskSignal[] = []
  const cleared: ClearedSignal[] = []

  for (const signal of signals) {
    if (policy.muted.includes(signal.dimension)) continue
    if (!reachesSeverity({ severity: signal.severity, floor: policy.consultAtOrAbove })) continue

    const by = grantCovering({ signal, grants: evidence.grants })
    if (by === undefined) standing.push(signal)
    else cleared.push({ signal, by })
  }

  const fatigued = standing.length > 0 && asksSoFar >= policy.asksPerThread
  const consults = standing.length > 0 && !fatigued

  return {
    triage: consults ? ETriage.Consult : ETriage.Clear,
    standing,
    cleared,
    fatigued,
  }
}
