import { EDeed, EDeedRealm, type Deed } from '../deed'
import { ERiskDimension, ESeverity } from '../dimension'
import { EOccupancy, type WorkspaceFacts, type WorktreeFact } from '../facts'
import { basenameOf } from '../path-set'
import type { RiskSignal, SignalProbe } from '../signals'
import {
  contendingDeeds,
  isOurs,
  losesSomething,
  ourWorktree,
  placesOf,
  riskSignal,
  takesSomethingAway,
  targetsInRealm,
  weInspectedTheWorktrees,
  worktreeAt,
} from './kit'

const dimension = ERiskDimension.Contention

const EXEMPT: ReadonlySet<EDeed> = new Set([EDeed.AddWorktree])

const heldNote = ({ worktree }: { worktree: WorktreeFact }): string => {
  if (worktree.occupancy !== EOccupancy.LiveOther) return ''
  if (worktree.heldBy === undefined) return ', held by another live session'
  return `, held by live process ${worktree.heldBy}`
}

const movesTheWholeCheckout = ({ deed }: { deed: Deed }): boolean => {
  if (takesSomethingAway({ deed })) return false
  return targetsInRealm({ deed, realm: EDeedRealm.GitWorktree }).length > 0
}

function signalsAt({
  deed,
  facts,
  worktree,
}: {
  deed: Deed
  facts: WorkspaceFacts
  worktree: WorktreeFact
}): readonly RiskSignal[] {
  const subject = `worktree:${basenameOf({ path: worktree.path })}`
  const changed = worktree.changedCount ?? 0

  if (changed > 0 && losesSomething({ deed, facts })) {
    return [
      riskSignal({
        dimension,
        severity: ESeverity.Grave,
        id: 'contention:dirty-worktree',
        subject,
        detail: `${deed.summary} in ${worktree.path}, which is not ours and carries ${changed} uncommitted change(s)${heldNote({ worktree })}`,
        ungrantable: true,
      }),
    ]
  }

  if (worktree.occupancy === EOccupancy.LiveOther) {
    return [
      riskSignal({
        dimension,
        severity: ESeverity.Grave,
        id: 'contention:live-worktree',
        subject,
        detail: `${deed.summary} in ${worktree.path}${heldNote({ worktree })}`,
      }),
    ]
  }

  if (changed === 0) return []

  if (worktree.isMain && deed.action === EDeed.FastForward) return []

  if (movesTheWholeCheckout({ deed })) {
    return [
      riskSignal({
        dimension,
        severity: ESeverity.Serious,
        id: 'contention:moves-another-checkout',
        subject,
        detail: `${deed.summary} in ${worktree.path}, a checkout this session does not stand in, over ${changed} uncommitted change(s)`,
      }),
    ]
  }

  if (worktree.isMain) return []

  return [
    riskSignal({
      dimension,
      severity: ESeverity.Serious,
      id: 'contention:writes-into-dirty-worktree',
      subject,
      detail: `${deed.summary} inside ${worktree.path}, another agent's worktree, which carries ${changed} uncommitted change(s)`,
    }),
  ]
}

function occupiedBySomeoneElse({
  deed,
  facts,
}: {
  deed: Deed
  facts: WorkspaceFacts
}): readonly RiskSignal[] {
  if (EXEMPT.has(deed.action)) return []
  if (!weInspectedTheWorktrees({ facts })) return []

  const seen = new Set<string>()

  return placesOf({ deed }).flatMap((path) => {
    const worktree = worktreeAt({ facts, path })
    if (worktree === undefined) return []
    if (isOurs({ facts, worktree })) return []
    if (seen.has(worktree.path)) return []
    seen.add(worktree.path)

    return signalsAt({ deed, facts, worktree })
  })
}

function branchCheckedOutElsewhere({
  deed,
  facts,
}: {
  deed: Deed
  facts: WorkspaceFacts
}): readonly RiskSignal[] {
  if (deed.action !== EDeed.DeleteBranch) return []
  const ours = ourWorktree({ facts })?.path

  return targetsInRealm({ deed, realm: EDeedRealm.GitRef }).flatMap((ref) => {
    const elsewhere = (facts.refs.find((fact) => fact.ref === ref)?.checkedOutAt ?? []).filter(
      (path) => path !== ours,
    )
    if (elsewhere.length === 0) return []

    return [
      riskSignal({
        dimension,
        severity: ESeverity.Grave,
        id: 'contention:branch-checked-out',
        subject: `ref:${ref}`,
        detail: `deletes ${ref}, which is checked out at ${elsewhere.join(', ')}`,
      }),
    ]
  })
}

export const contentionProbe: SignalProbe = {
  dimension,
  probe: (evidence) =>
    contendingDeeds({ evidence }).flatMap((deed) => [
      ...occupiedBySomeoneElse({ deed, facts: evidence.facts }),
      ...branchCheckedOutElsewhere({ deed, facts: evidence.facts }),
    ]),
}
