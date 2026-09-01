import { EAgentStatus } from '@dltech/atlas-core'

export type CrewMember = {
  agentId: string
  spawnedBy: string
  status: EAgentStatus
  endedAt: string | null
  deliveredAt: string | null
  lastViewedAt: string | null
}

export enum ECrewStanding {
  Live = 'live',
  Held = 'held',
  Retiring = 'retiring',
  Retired = 'retired',
}

export const DEFAULT_CREW_GRACE_MS = 3 * 60_000

const IS_TERMINAL: Record<EAgentStatus, boolean> = {
  [EAgentStatus.Running]: false,
  [EAgentStatus.Blocked]: false,
  [EAgentStatus.Finished]: true,
  [EAgentStatus.Failed]: true,
  [EAgentStatus.Stopped]: true,
}

const NEEDS_ACKNOWLEDGING: Record<EAgentStatus, boolean> = {
  [EAgentStatus.Running]: false,
  [EAgentStatus.Blocked]: false,
  [EAgentStatus.Finished]: false,
  [EAgentStatus.Failed]: true,
  [EAgentStatus.Stopped]: true,
}

const instantOf = (iso: string): number | null => {
  const at = Date.parse(iso)
  return Number.isNaN(at) ? null : at
}

const ancestorsOfLive = (crew: readonly CrewMember[]): ReadonlySet<string> => {
  const parentOf = new Map<string, string>()
  for (const member of crew) parentOf.set(member.agentId, member.spawnedBy)

  const holding = new Set<string>()
  for (const member of crew) {
    if (IS_TERMINAL[member.status]) continue

    let ancestor = parentOf.get(member.agentId)
    while (ancestor !== undefined && !holding.has(ancestor)) {
      holding.add(ancestor)
      ancestor = parentOf.get(ancestor)
    }
  }

  return holding
}

const graceStartedAt = (member: CrewMember): number | null => {
  if (member.endedAt === null) return null

  const ended = instantOf(member.endedAt)
  if (ended === null) return null

  let latest = ended
  for (const mark of [member.deliveredAt, member.lastViewedAt]) {
    if (mark === null) continue

    const at = instantOf(mark)
    if (at === null) return null

    latest = Math.max(latest, at)
  }

  return latest
}

const standingOf = (args: {
  member: CrewMember
  holdingLive: ReadonlySet<string>
  viewing: string | null
  now: number
  graceMs: number
}): ECrewStanding => {
  const { member } = args
  if (!IS_TERMINAL[member.status]) return ECrewStanding.Live
  if (member.deliveredAt === null) return ECrewStanding.Held
  if (member.agentId === args.viewing) return ECrewStanding.Held
  if (args.holdingLive.has(member.agentId)) return ECrewStanding.Held
  if (member.lastViewedAt === null && NEEDS_ACKNOWLEDGING[member.status]) return ECrewStanding.Held

  const since = graceStartedAt(member)
  if (since === null) return ECrewStanding.Held

  return args.now - since >= args.graceMs ? ECrewStanding.Retired : ECrewStanding.Retiring
}

export function crewStanding(args: {
  member: CrewMember
  crew: readonly CrewMember[]
  viewing: string | null
  now: number
  graceMs: number
}): ECrewStanding {
  return standingOf({
    member: args.member,
    holdingLive: ancestorsOfLive(args.crew),
    viewing: args.viewing,
    now: args.now,
    graceMs: args.graceMs,
  })
}

export type CrewPartition<TMember extends CrewMember> = {
  shown: readonly TMember[]
  retired: readonly TMember[]
  standings: ReadonlyMap<string, ECrewStanding>
}

export function partitionCrew<TMember extends CrewMember>(args: {
  crew: readonly TMember[]
  viewing: string | null
  now: number
  graceMs: number
}): CrewPartition<TMember> {
  const holdingLive = ancestorsOfLive(args.crew)

  const shown: TMember[] = []
  const retired: TMember[] = []
  const standings = new Map<string, ECrewStanding>()

  for (const member of args.crew) {
    const standing = standingOf({
      member,
      holdingLive,
      viewing: args.viewing,
      now: args.now,
      graceMs: args.graceMs,
    })

    standings.set(member.agentId, standing)
    if (standing === ECrewStanding.Retired) retired.push(member)
    else shown.push(member)
  }

  return { shown, retired, standings }
}
