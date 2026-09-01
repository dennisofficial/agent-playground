import { ERiskDimension, ESeverity } from '../dimension'
import type { CallEvidence } from '../evidence'
import type { RiskSignal, SignalProbe } from '../signals'
import { losesSomething, mutatingDeeds, riskSignal } from './kit'

const dimension = ERiskDimension.Provenance

function probe(evidence: CallEvidence): readonly RiskSignal[] {
  const ingested = evidence.recent.filter((act) => act.ingestedUntrustedContent)
  if (ingested.length === 0) return []

  const deeds = mutatingDeeds({ evidence })
  if (deeds.length === 0) return []

  const loses = deeds.some((deed) => losesSomething({ deed, facts: evidence.facts }))
  const sources = [...new Set(ingested.map((act) => act.name))].join(', ')

  return [
    riskSignal({
      dimension,
      severity: loses ? ESeverity.Serious : ESeverity.Note,
      id: 'provenance:after-untrusted-content',
      subject: `tool:${evidence.toolName}`,
      detail: `${deeds[0]?.summary ?? 'changes something'} after this turn read content Atlas did not author (${sources})`,
    }),
  ]
}

export const provenanceProbe: SignalProbe = { dimension, probe }
