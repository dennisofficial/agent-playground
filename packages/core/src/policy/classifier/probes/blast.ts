import { EDeed, EDeedRealm, type Deed } from '../deed'
import { ERiskDimension, ESeverity } from '../dimension'
import { EReadConfidence } from '../command/read-command'
import type { CallEvidence } from '../evidence'
import { weLookedAtNothing, type WorkspaceFacts } from '../facts'
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

const CONSEQUENTIAL: ReadonlySet<EToolEffect> = new Set([
  EToolEffect.Destructive,
  EToolEffect.Write,
])

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

  reading.segments.forEach((segment, index) => {
    if (!segment.pipesIntoInterpreter) return
    const interpreter = reading.segments[index + 1]?.program ?? segment.program

    signals.push(
      riskSignal({
        dimension,
        severity: ESeverity.Grave,
        id: 'blast:pipes-into-interpreter',
        subject: `interpreter:${interpreter}`,
        detail: `pipes fetched bytes straight into ${interpreter}, so nothing read what runs`,
      }),
    )
  })

  const blind = reading.segments.filter(
    (segment) => destroysItsOperands({ segment }) && segment.unresolvedExpansions.length > 0,
  )
  for (const segment of blind) {
    const [first] = segment.unresolvedExpansions
    signals.push(
      riskSignal({
        dimension,
        severity: ESeverity.Grave,
        id: 'blast:unresolved-destructive-operand',
        subject: `expansion:${first ?? segment.program}`,
        detail: `${segment.program} destroys operands that expand at run time (${segment.unresolvedExpansions.join(', ')})`,
      }),
    )
  }

  if (
    reading.confidence === EReadConfidence.Opaque &&
    evidence.effect === EToolEffect.Destructive
  ) {
    const destroying = reading.segments.find((segment) => destroysItsOperands({ segment }))
    signals.push(
      riskSignal({
        dimension,
        severity: ESeverity.Serious,
        id: 'blast:opaque-destructive-command',
        subject: `command:${destroying?.program ?? evidence.toolName}`,
        detail: 'a destructive tool was handed a command the reader could not resolve',
      }),
    )
  }

  return signals
}

function anUnreadableWorkspace({ evidence }: { evidence: CallEvidence }): readonly RiskSignal[] {
  if (!weLookedAtNothing({ facts: evidence.facts })) return []
  if (mutatingDeeds({ evidence }).length === 0) return []

  return [
    riskSignal({
      dimension,
      severity: ESeverity.Note,
      id: 'blast:workspace-unreadable',
      subject: `workspace:${evidence.facts.projectDirectory}`,
      detail: 'Atlas could not read the workspace, so the probes that need it stayed silent',
    }),
  ]
}

function anUndeclaredTool({ evidence }: { evidence: CallEvidence }): readonly RiskSignal[] {
  if (evidence.reading !== undefined) return []
  if (!CONSEQUENTIAL.has(evidence.effect)) return []
  if (!evidence.deeds.some((deed) => deed.action === EDeed.Unreadable)) return []

  return [
    riskSignal({
      dimension,
      severity: ESeverity.Serious,
      id: 'blast:undeclared-paths',
      subject: `tool:${evidence.toolName}`,
      detail: `${evidence.toolName} changes the world without declaring which paths it touches, so no probe can see what it would reach`,
    }),
  ]
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
      subject: `dependencies:${managers[0]?.program ?? evidence.toolName}`,
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
    ...anUndeclaredTool({ evidence }),
    ...anUnreadableWorkspace({ evidence }),
    ...mutatingDeeds({ evidence }).flatMap((deed) => [
      ...sweepingAWholeTree({ deed, facts: evidence.facts }),
      ...cleaning({ deed, evidence }),
      ...dependencies({ deed, evidence }),
    ]),
  ],
}
