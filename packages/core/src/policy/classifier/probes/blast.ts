import { EDeed, EDeedRealm, type Deed } from '../deed'
import { ERiskDimension, ESeverity } from '../dimension'
import { EReadConfidence } from '../command/read-command'
import type { CallEvidence } from '../evidence'
import type { WorkspaceFacts } from '../facts'
import { destroysItsOperands } from '../command/reading'
import { packageManagers } from '../command/verbs/packages'
import { normalisePath } from '../path-set'
import type { RiskSignal, SignalProbe } from '../signals'
import { EToolEffect } from '../../../tools/tool'
import {
  anySegmentFlagged,
  isRegenerable,
  mutatingDeeds,
  placesOf,
  riskSignal,
  segmentsRunning,
  targetsInRealm,
  worktreeAt,
  worktreeSubject,
} from './kit'

const dimension = ERiskDimension.Blast

const WHOLE_MACHINE: ReadonlySet<string> = new Set(['/', '~', '.'])

function sweepingAWholeTree({
  deed,
  facts,
}: {
  deed: Deed
  facts: WorkspaceFacts
}): readonly RiskSignal[] {
  if (deed.action !== EDeed.RemovePath) return []

  return placesOf({ deed }).flatMap((path) => {
    const normalised = normalisePath({ path })
    const root =
      WHOLE_MACHINE.has(normalised) ||
      normalised === facts.projectDirectory ||
      worktreeAt({ facts, path })?.path === normalised
    if (!root) return []
    if (isRegenerable({ facts, path })) return []

    return [
      riskSignal({
        dimension,
        severity: ESeverity.Grave,
        id: 'blast:removes-a-whole-tree',
        subject: `path:${normalised}`,
        detail: `removes ${normalised} whole, not a path inside it`,
      }),
    ]
  })
}

function cleaning({
  deed,
  evidence,
}: {
  deed: Deed
  evidence: CallEvidence
}): readonly RiskSignal[] {
  if (deed.action !== EDeed.CleanUntracked) return []
  if (targetsInRealm({ deed, realm: EDeedRealm.GitWorktree }).length === 0) return []

  const ignoredToo = anySegmentFlagged({
    segments: segmentsRunning({ reading: evidence.reading, program: 'git', verb: 'clean' }),
    flags: ['-x', '-X'],
  })

  return [
    riskSignal({
      dimension,
      severity: ignoredToo ? ESeverity.Grave : ESeverity.Serious,
      id: 'blast:clean-whole-tree',
      subject: worktreeSubject({ facts: evidence.facts, path: deed.cwd ?? '' }),
      detail: ignoredToo
        ? 'removes every untracked and every ignored file in the tree, naming no pathspec'
        : 'removes every untracked file in the tree, naming no pathspec',
    }),
  ]
}

function unreadableShell({ evidence }: { evidence: CallEvidence }): readonly RiskSignal[] {
  const reading = evidence.reading
  if (reading === undefined) return []

  const signals: RiskSignal[] = []

  if (reading.segments.some((segment) => segment.pipesIntoInterpreter)) {
    signals.push(
      riskSignal({
        dimension,
        severity: ESeverity.Grave,
        id: 'blast:pipes-into-interpreter',
        subject: `tool:${evidence.toolName}`,
        detail: 'pipes fetched bytes straight into an interpreter, so nothing read what runs',
      }),
    )
  }

  const blind = reading.segments.filter(
    (segment) => destroysItsOperands({ segment }) && segment.unresolvedExpansions.length > 0,
  )
  for (const segment of blind) {
    signals.push(
      riskSignal({
        dimension,
        severity: ESeverity.Grave,
        id: 'blast:unresolved-destructive-operand',
        subject: `tool:${evidence.toolName}`,
        detail: `${segment.program} destroys operands that expand at run time (${segment.unresolvedExpansions.join(', ')})`,
      }),
    )
  }

  if (
    reading.confidence === EReadConfidence.Opaque &&
    evidence.effect === EToolEffect.Destructive
  ) {
    signals.push(
      riskSignal({
        dimension,
        severity: ESeverity.Serious,
        id: 'blast:opaque-destructive-command',
        subject: `tool:${evidence.toolName}`,
        detail: 'a destructive tool was handed a command the reader could not resolve',
      }),
    )
  }

  return signals
}

function dependencies({
  deed,
  evidence,
}: {
  deed: Deed
  evidence: CallEvidence
}): readonly RiskSignal[] {
  if (deed.action !== EDeed.MutateDependencies) return []

  const managers = (evidence.reading?.segments ?? []).filter((segment) =>
    packageManagers.has(segment.program),
  )
  const forced = anySegmentFlagged({ segments: managers, flags: ['--force', '-f'] })
  const trusts = managers.some(
    (segment) => segment.verb === 'pm' && segment.rawOperands.includes('trust'),
  )

  return [
    riskSignal({
      dimension,
      severity: forced || trusts ? ESeverity.Serious : ESeverity.Note,
      id: 'blast:dependency-change',
      subject: `tool:${evidence.toolName}`,
      detail:
        forced || trusts
          ? 'changes dependencies past the lockfile or the postinstall allowlist'
          : 'changes the installed dependencies and the lockfile',
    }),
  ]
}

export const blastProbe: SignalProbe = {
  dimension,
  probe: (evidence) => [
    ...unreadableShell({ evidence }),
    ...mutatingDeeds({ evidence }).flatMap((deed) => [
      ...sweepingAWholeTree({ deed, facts: evidence.facts }),
      ...cleaning({ deed, evidence }),
      ...dependencies({ deed, evidence }),
    ]),
  ],
}
