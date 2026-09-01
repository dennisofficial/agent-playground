import { EDeed, EDeedRealm, type Deed } from '../deed'
import { ERiskDimension, ESeverity } from '../dimension'
import { EOccupancy, type WorkspaceFacts, type WorktreeFact } from '../facts'
import { basenameOf } from '../path-set'
import type { RiskSignal, SignalProbe } from '../signals'
import {
  isOurs,
  mutatingDeeds,
  ourWorktree,
  placesOf,
  riskSignal,
  targetsInRealm,
  worktreeAt,
} from './kit'

const dimension = ERiskDimension.Contention

const EXEMPT: ReadonlySet<EDeed> = new Set([EDeed.AddWorktree])

const heldNote = ({ worktree }: { worktree: WorktreeFact }): string => {
  if (worktree.occupancy !== EOccupancy.LiveOther) return ''
  if (worktree.heldBy === undefined) return ', held by another live session'
  return `, held by live process ${worktree.heldBy}`
}

function occupiedBySomeoneElse({
  deed,
  facts,
}: {
  deed: Deed
  facts: WorkspaceFacts
}): readonly RiskSignal[] {
  if (EXEMPT.has(deed.action)) return []

  const seen = new Set<string>()

  return placesOf({ deed }).flatMap((path) => {
    const worktree = worktreeAt({ facts, path })
    if (worktree === undefined) return []
    if (isOurs({ facts, worktree })) return []
    if (seen.has(worktree.path)) return []
    seen.add(worktree.path)

    const subject = `worktree:${basenameOf({ path: worktree.path })}`
    const changed = worktree.changedCount

    if (changed !== undefined && changed > 0) {
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

    if (worktree.occupancy !== EOccupancy.LiveOther) return []

    return [
      riskSignal({
        dimension,
        severity: ESeverity.Grave,
        id: 'contention:live-worktree',
        subject,
        detail: `${deed.summary} in ${worktree.path}${heldNote({ worktree })}`,
      }),
    ]
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
    mutatingDeeds({ evidence }).flatMap((deed) => [
      ...occupiedBySomeoneElse({ deed, facts: evidence.facts }),
      ...branchCheckedOutElsewhere({ deed, facts: evidence.facts }),
    ]),
}
