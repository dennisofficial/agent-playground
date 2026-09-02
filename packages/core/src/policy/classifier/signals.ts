import { ESeverity, type ERiskDimension } from './dimension'
import type { CallEvidence } from './evidence'
import { blastProbe } from './probes/blast'
import { contentionProbe } from './probes/contention'
import { exposureProbe } from './probes/exposure'
import { irreversibilityProbe } from './probes/irreversibility'
import { provenanceProbe } from './probes/provenance'
import { reachProbe } from './probes/reach'
import { sharedHistoryProbe } from './probes/shared-history'

export type RiskSignal = {
  dimension: ERiskDimension
  severity: ESeverity
  id: string
  subject: string
  detail: string
  ungrantable: boolean
  unverified: boolean
}

export type SignalProbe = {
  dimension: ERiskDimension
  probe(evidence: CallEvidence): readonly RiskSignal[]
}

const RISING: readonly ESeverity[] = [ESeverity.Note, ESeverity.Serious, ESeverity.Grave]

export function severityRank({ severity }: { severity: ESeverity }): number {
  return RISING.indexOf(severity)
}

export function reachesSeverity({
  severity,
  floor,
}: {
  severity: ESeverity
  floor: ESeverity
}): boolean {
  return severityRank({ severity }) >= severityRank({ severity: floor })
}

export const RISK_PROBES: readonly SignalProbe[] = [
  irreversibilityProbe,
  reachProbe,
  contentionProbe,
  sharedHistoryProbe,
  exposureProbe,
  provenanceProbe,
  blastProbe,
]

export function signalsFor({
  evidence,
  probes,
}: {
  evidence: CallEvidence
  probes?: readonly SignalProbe[] | undefined
}): readonly RiskSignal[] {
  const found: RiskSignal[] = []
  const seen = new Set<string>()

  for (const probe of probes ?? RISK_PROBES) {
    let raised: readonly RiskSignal[] = []
    try {
      raised = probe.probe(evidence)
    } catch {
      continue
    }

    for (const signal of raised) {
      const key = `${signal.id}|${signal.subject}`
      if (seen.has(key)) continue
      seen.add(key)
      found.push(signal)
    }
  }

  return found
}
