import type { CommandReading } from './command/read-command'
import { EDeed, mutates, type Deed } from './deed'
import type { OperatorUtterance } from './evidence'
import { isUnderPath } from './path-set'
import { placesOf, segmentsRunning } from './probes/kit'

export enum EUndoing {
  PathRecreated = 'path-recreated',
  WorkDiscarded = 'work-discarded',
  CommitReverted = 'commit-reverted',
  OperatorRegret = 'operator-regret',
}

export type ReplayedAct = {
  seq: number
  deeds: readonly Deed[]
  reading: CommandReading | undefined
}

export type Undoing = { kind: EUndoing; seq: number; detail: string }

const DEEDS_THAT_TAKE_A_PATH_AWAY: ReadonlySet<EDeed> = new Set([
  EDeed.RemovePath,
  EDeed.CleanUntracked,
  EDeed.RemoveWorktree,
])

const DEEDS_THAT_PUT_A_PATH_BACK: ReadonlySet<EDeed> = new Set([EDeed.WriteFile, EDeed.AddWorktree])

const DEEDS_THAT_THROW_A_TREE_AWAY: ReadonlySet<EDeed> = new Set([
  EDeed.DiscardWorkingTree,
  EDeed.RewriteHistory,
])

const REGRET =
  /\b(undo|undone|put (?:it|that|them|those) back|bring (?:it|that|them) back|roll (?:it|that) back|restore|should ?n[o']t have|did ?n[o']t mean|by mistake|oops|wrong (?:branch|file|directory|worktree|repo)|you (?:just )?(?:deleted|removed|reset|wiped|nuked|blew away))\b/i

const overlapping = ({ one, other }: { one: string; other: string }): boolean =>
  isUnderPath({ directory: one, path: other }) || isUnderPath({ directory: other, path: one })

const placesWhere = ({
  deeds,
  actions,
}: {
  deeds: readonly Deed[]
  actions: ReadonlySet<EDeed>
}): readonly string[] =>
  deeds.filter((deed) => actions.has(deed.action)).flatMap((deed) => placesOf({ deed }))

const touchedBy = ({ deeds }: { deeds: readonly Deed[] }): readonly string[] =>
  deeds.filter((deed) => mutates({ deed })).flatMap((deed) => placesOf({ deed }))

const sharedPlace = ({
  gone,
  back,
}: {
  gone: readonly string[]
  back: readonly string[]
}): string | undefined =>
  back.find((path) => gone.some((lost) => overlapping({ one: lost, other: path })))

function pathRecreated({
  candidate,
  act,
}: {
  candidate: ReplayedAct
  act: ReplayedAct
}): Undoing | undefined {
  const gone = placesWhere({ deeds: candidate.deeds, actions: DEEDS_THAT_TAKE_A_PATH_AWAY })
  if (gone.length === 0) return undefined

  const at = sharedPlace({
    gone,
    back: placesWhere({ deeds: act.deeds, actions: DEEDS_THAT_PUT_A_PATH_BACK }),
  })
  if (at === undefined) return undefined

  return {
    kind: EUndoing.PathRecreated,
    seq: act.seq,
    detail: `${at} was written again after this call removed it`,
  }
}

function workDiscarded({
  candidate,
  act,
}: {
  candidate: ReplayedAct
  act: ReplayedAct
}): Undoing | undefined {
  const at = sharedPlace({
    gone: touchedBy({ deeds: candidate.deeds }),
    back: placesWhere({ deeds: act.deeds, actions: DEEDS_THAT_THROW_A_TREE_AWAY }),
  })
  if (at === undefined) return undefined

  return {
    kind: EUndoing.WorkDiscarded,
    seq: act.seq,
    detail: `${at} was reset or rewritten after this call changed it`,
  }
}

function commitReverted({ act }: { act: ReplayedAct }): Undoing | undefined {
  const reverts = segmentsRunning({ reading: act.reading, program: 'git', verb: 'revert' })
  if (reverts.length === 0) return undefined

  return {
    kind: EUndoing.CommitReverted,
    seq: act.seq,
    detail: 'a later commit in this thread reverted another',
  }
}

function operatorRegret({ said }: { said: readonly OperatorUtterance[] }): Undoing | undefined {
  const regretted = said.find((utterance) => REGRET.test(utterance.text))
  if (regretted === undefined) return undefined

  return {
    kind: EUndoing.OperatorRegret,
    seq: regretted.seq,
    detail: `the developer then said: ${regretted.text}`,
  }
}

export function undoingAfter({
  candidate,
  acts,
  said,
}: {
  candidate: ReplayedAct
  acts: readonly ReplayedAct[]
  said: readonly OperatorUtterance[]
}): Undoing | undefined {
  if (!candidate.deeds.some((deed) => mutates({ deed }))) return undefined

  for (const act of acts.filter((later) => later.seq > candidate.seq)) {
    const undone =
      pathRecreated({ candidate, act }) ??
      workDiscarded({ candidate, act }) ??
      commitReverted({ act })
    if (undone !== undefined) return undone
  }

  return operatorRegret({ said: said.filter((utterance) => utterance.seq > candidate.seq) })
}
