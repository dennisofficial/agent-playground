import { EDeed } from '../deed'
import { ERiskDimension, ESeverity } from '../dimension'
import type { CallEvidence } from '../evidence'
import { looksSecretShaped, namesASecretLiteral } from '../shapes'
import type { RiskSignal, SignalProbe } from '../signals'
import { mutatingDeeds, placesOf, riskSignal } from './kit'

const dimension = ERiskDimension.Exposure

const SINKS: ReadonlySet<EDeed> = new Set([
  EDeed.DeployEnvironment,
  EDeed.PublishArtifact,
  EDeed.SendOutbound,
])

const sinkDeeds = ({ evidence }: { evidence: CallEvidence }) =>
  evidence.deeds.filter((deed) => SINKS.has(deed.action))

const literalInTheCommand = ({ evidence }: { evidence: CallEvidence }): boolean =>
  (evidence.reading?.segments ?? []).some((segment) =>
    [...segment.rawOperands, ...segment.flags].some((word) => namesASecretLiteral({ text: word })),
  )

function probe(evidence: CallEvidence): readonly RiskSignal[] {
  const sinks = sinkDeeds({ evidence })
  const secretPaths = mutatingDeeds({ evidence })
    .flatMap((deed) => placesOf({ deed }))
    .filter((path) => looksSecretShaped({ path }))

  if (sinks.length === 0) {
    return [...new Set(secretPaths)].map((path) =>
      riskSignal({
        dimension,
        severity: ESeverity.Note,
        id: 'exposure:secret-shaped-path',
        subject: `path:${path}`,
        detail: `touches ${path}, which is shaped like a credential file, and sends nothing anywhere`,
      }),
    )
  }

  const sink = sinks[0]
  const signals: RiskSignal[] = []

  if (literalInTheCommand({ evidence })) {
    signals.push(
      riskSignal({
        dimension,
        severity: ESeverity.Grave,
        id: 'exposure:literal-credential',
        subject: `sink:${sink?.action ?? evidence.toolName}`,
        detail: `${sink?.summary ?? 'sends data outbound'} with a credential written into the command itself`,
        ungrantable: true,
      }),
    )
  }

  for (const path of new Set(secretPaths)) {
    signals.push(
      riskSignal({
        dimension,
        severity: ESeverity.Grave,
        id: 'exposure:secret-into-sink',
        subject: `path:${path}`,
        detail: `${sink?.summary ?? 'sends data outbound'} in the same call that touches ${path}`,
      }),
    )
  }

  if (evidence.recent.some((act) => act.readSecretShapedPath)) {
    signals.push(
      riskSignal({
        dimension,
        severity: ESeverity.Serious,
        id: 'exposure:secret-read-then-sink',
        subject: `sink:${sink?.action ?? evidence.toolName}`,
        detail: `${sink?.summary ?? 'sends data outbound'} after an earlier call read a credential-shaped file`,
      }),
    )
  }

  return signals
}

export const exposureProbe: SignalProbe = { dimension, probe }
