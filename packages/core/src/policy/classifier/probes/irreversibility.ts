import { EDeed, EDeedRealm, type Deed } from '../deed'
import { ERiskDimension, ESeverity } from '../dimension'
import type { CallEvidence } from '../evidence'
import { weKnowWhereTheProjectIs, type WorkspaceFacts } from '../facts'
import type { RiskSignal, SignalProbe } from '../signals'
import {
  anySegmentFlagged,
  insideProject,
  isOurs,
  isRegenerable,
  mutatingDeeds,
  placesOf,
  riskSignal,
  segmentsRunning,
  targetsInRealm,
  weInspectedTheWorktrees,
  worktreeAt,
  worktreeSubject,
} from './kit'

const dimension = ERiskDimension.Irreversibility

const changedCountAt = (args: { facts: WorkspaceFacts; path: string }): number | undefined => {
  const worktree = worktreeAt(args)
  if (worktree === undefined) return undefined
  if (worktree.changedCount !== undefined) return worktree.changedCount
  if (isOurs({ facts: args.facts, worktree })) return args.facts.ownChangedPaths.length
  return undefined
}

function discarding({ deed, facts }: { deed: Deed; facts: WorkspaceFacts }): readonly RiskSignal[] {
  if (!weInspectedTheWorktrees({ facts })) return []

  const trees = targetsInRealm({ deed, realm: EDeedRealm.GitWorktree })

  if (trees.length === 0) {
    return placesOf({ deed }).map((path) =>
      riskSignal({
        dimension,
        severity: ESeverity.Note,
        id: 'irreversibility:discard-pathspec',
        subject: `path:${path}`,
        detail: `discards uncommitted changes under ${path}`,
      }),
    )
  }

  return trees.flatMap((path) => {
    const changed = changedCountAt({ facts, path })
    if (changed === 0) return []

    return [
      riskSignal({
        dimension,
        severity: changed === undefined ? ESeverity.Serious : ESeverity.Grave,
        id: 'irreversibility:discard-tree',
        subject: worktreeSubject({ facts, path }),
        detail:
          changed === undefined
            ? `discards every uncommitted change in ${path}, whose dirtiness is unknown`
            : `discards ${changed} uncommitted change(s) in ${path}`,
      }),
    ]
  })
}

function removing({ deed, facts }: { deed: Deed; facts: WorkspaceFacts }): readonly RiskSignal[] {
  if (!weKnowWhereTheProjectIs({ facts })) return []

  return placesOf({ deed }).flatMap((path) => {
    if (isRegenerable({ facts, path })) return []

    return [
      riskSignal({
        dimension,
        severity: insideProject({ facts, path }) ? ESeverity.Note : ESeverity.Serious,
        id: insideProject({ facts, path })
          ? 'irreversibility:remove-inside-project'
          : 'irreversibility:remove-outside-project',
        subject: `path:${path}`,
        detail: `removes ${path}, which nothing regenerates`,
      }),
    ]
  })
}

function removingAWorktree({
  deed,
  evidence,
}: {
  deed: Deed
  evidence: CallEvidence
}): readonly RiskSignal[] {
  const forced = anySegmentFlagged({
    segments: segmentsRunning({ reading: evidence.reading, program: 'git', verb: 'worktree' }),
    flags: ['--force', '-f'],
  })

  return placesOf({ deed }).map((path) =>
    riskSignal({
      dimension,
      severity: forced ? ESeverity.Grave : ESeverity.Note,
      id: forced ? 'irreversibility:force-remove-worktree' : 'irreversibility:remove-worktree',
      subject: worktreeSubject({ facts: evidence.facts, path }),
      detail: forced
        ? `removes the worktree at ${path} over git's own refusal to lose work`
        : `removes the worktree at ${path}, which git refuses to do while work is uncommitted`,
    }),
  )
}

function droppingRecovery({
  deed,
  evidence,
}: {
  deed: Deed
  evidence: CallEvidence
}): readonly RiskSignal[] {
  return [
    riskSignal({
      dimension,
      severity: ESeverity.Grave,
      id: 'irreversibility:drop-recovery',
      subject: worktreeSubject({ facts: evidence.facts, path: deed.cwd ?? '' }),
      detail: 'drops the reflog and unreachable objects that make lost commits recoverable',
    }),
  ]
}

function signalsFor({
  deed,
  evidence,
}: {
  deed: Deed
  evidence: CallEvidence
}): readonly RiskSignal[] {
  const facts = evidence.facts

  if (deed.action === EDeed.DiscardWorkingTree) return discarding({ deed, facts })
  if (deed.action === EDeed.RemovePath) return removing({ deed, facts })
  if (deed.action === EDeed.RemoveWorktree) return removingAWorktree({ deed, evidence })
  if (deed.action === EDeed.DropRecovery) return droppingRecovery({ deed, evidence })

  if (deed.action !== EDeed.MutateStash) return []

  return [
    riskSignal({
      dimension,
      severity: ESeverity.Serious,
      id: 'irreversibility:stash',
      subject: worktreeSubject({ facts, path: deed.cwd ?? '' }),
      detail: 'mutates the stash stack, which every worktree of the repository shares',
    }),
  ]
}

export const irreversibilityProbe: SignalProbe = {
  dimension,
  probe: (evidence) =>
    mutatingDeeds({ evidence }).flatMap((deed) => signalsFor({ deed, evidence })),
}
