import {
  contendsForItsPlace,
  EDeed,
  EDeedRealm,
  filesystemTargets,
  mutates,
  type Deed,
} from '../deed'
import type { ERiskDimension, ESeverity } from '../dimension'
import type { CallEvidence } from '../evidence'
import {
  EOccupancy,
  weKnowWhereTheProjectIs,
  weLookedAt,
  type WorkspaceFacts,
  type WorktreeFact,
} from '../facts'
import { basenameOf, isUnderPath } from '../path-set'
import { homeDotDirectory, insideTemporaryRoot, looksRegenerable } from '../shapes'
import type { RiskSignal } from '../signals'
import type { CommandReading, CommandSegment } from '../command/read-command'

const DEEDS_THAT_LOSE_SOMETHING: ReadonlySet<EDeed> = new Set([
  EDeed.CleanUntracked,
  EDeed.DeleteBranch,
  EDeed.DeployEnvironment,
  EDeed.DiscardWorkingTree,
  EDeed.DropRecovery,
  EDeed.ForcePush,
  EDeed.KillProcess,
  EDeed.MutateStash,
  EDeed.RemovePath,
  EDeed.RemoveWorktree,
  EDeed.RewriteHistory,
])

const TOOL_OWNED_DOT_DIRECTORIES: ReadonlySet<string> = new Set([
  '.agents',
  '.bun',
  '.cache',
  '.claude',
  '.config',
  '.local',
  '.npm',
])

export function riskSignal(args: {
  dimension: ERiskDimension
  severity: ESeverity
  id: string
  subject: string
  detail: string
  ungrantable?: boolean | undefined
}): RiskSignal {
  return {
    dimension: args.dimension,
    severity: args.severity,
    id: args.id,
    subject: args.subject,
    detail: args.detail,
    ungrantable: args.ungrantable ?? false,
  }
}

export function mutatingDeeds({ evidence }: { evidence: CallEvidence }): readonly Deed[] {
  return evidence.deeds.filter((deed) => mutates({ deed }))
}

export function contendingDeeds({ evidence }: { evidence: CallEvidence }): readonly Deed[] {
  return evidence.deeds.filter((deed) => contendsForItsPlace({ deed }))
}

export function placesOf({ deed }: { deed: Deed }): readonly string[] {
  const named = filesystemTargets({ deed }).map((target) => target.value)
  if (named.length > 0) return [...new Set(named)]
  return deed.cwd === undefined ? [] : [deed.cwd]
}

export function targetsInRealm({
  deed,
  realm,
}: {
  deed: Deed
  realm: EDeedRealm
}): readonly string[] {
  return [...new Set(deed.targets.filter((target) => target.realm === realm).map((t) => t.value))]
}

export function worktreeAt({
  facts,
  path,
}: {
  facts: WorkspaceFacts
  path: string
}): WorktreeFact | undefined {
  let deepest: WorktreeFact | undefined
  for (const worktree of facts.worktrees) {
    if (!isUnderPath({ directory: worktree.path, path })) continue
    if (deepest === undefined || worktree.path.length > deepest.path.length) deepest = worktree
  }

  return deepest
}

export function ourWorktree({ facts }: { facts: WorkspaceFacts }): WorktreeFact | undefined {
  return worktreeAt({ facts, path: facts.projectDirectory })
}

export function isOurs({
  facts,
  worktree,
}: {
  facts: WorkspaceFacts
  worktree: WorktreeFact
}): boolean {
  if (worktree.occupancy === EOccupancy.Ours) return true
  return ourWorktree({ facts })?.path === worktree.path
}

export function insideProject({ facts, path }: { facts: WorkspaceFacts; path: string }): boolean {
  return isUnderPath({ directory: facts.projectDirectory, path })
}

export function weInspectedTheWorktrees({ facts }: { facts: WorkspaceFacts }): boolean {
  return weLookedAt({ facts, realm: EDeedRealm.GitWorktree })
}

export function isRegenerable({ facts, path }: { facts: WorkspaceFacts; path: string }): boolean {
  if (!insideProject({ facts, path })) return false
  return looksRegenerable({ path, names: facts.regenerablePaths })
}

export function belongsToTheOperatorsTools({ path }: { path: string }): boolean {
  if (insideTemporaryRoot({ path })) return true
  const dot = homeDotDirectory({ path })
  return dot !== undefined && TOOL_OWNED_DOT_DIRECTORIES.has(dot)
}

export function takesSomethingAway({ deed }: { deed: Deed }): boolean {
  return DEEDS_THAT_LOSE_SOMETHING.has(deed.action)
}

export function losesSomething({ deed, facts }: { deed: Deed; facts: WorkspaceFacts }): boolean {
  if (!takesSomethingAway({ deed })) return false
  if (!weKnowWhereTheProjectIs({ facts })) return false
  const places = placesOf({ deed })
  if (places.length === 0) return true
  return !places.every((path) => isRegenerable({ facts, path }))
}

export function worktreeSubject({ facts, path }: { facts: WorkspaceFacts; path: string }): string {
  const worktree = worktreeAt({ facts, path })
  if (worktree === undefined) return `path:${path}`
  return `worktree:${basenameOf({ path: worktree.path })}`
}

export function segmentsRunning({
  reading,
  program,
  verb,
}: {
  reading: CommandReading | undefined
  program: string
  verb: string
}): readonly CommandSegment[] {
  if (reading === undefined) return []
  return reading.segments.filter((segment) => segment.program === program && segment.verb === verb)
}

export function anySegmentFlagged({
  segments,
  flags,
}: {
  segments: readonly CommandSegment[]
  flags: readonly string[]
}): boolean {
  return segments.some((segment) => flags.some((flag) => segment.flags.includes(flag)))
}
