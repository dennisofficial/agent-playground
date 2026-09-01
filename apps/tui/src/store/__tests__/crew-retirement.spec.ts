import { EAgentStatus } from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import {
  DEFAULT_CREW_GRACE_MS,
  ECrewStanding,
  crewStanding,
  partitionCrew,
  type CrewMember,
} from '../crew-retirement'

const NOW = Date.parse('2026-01-01T12:00:00.000Z')

const MINUTE_MS = 60_000

const HOUR_MS = 60 * MINUTE_MS

const GRACE_MS = 3 * MINUTE_MS

const ago = (ms: number): string => new Date(NOW - ms).toISOString()

const ROOT = 'thr_root'

const CHILD = 'thr_child'

const member = (over: Partial<CrewMember> = {}): CrewMember => ({
  agentId: CHILD,
  spawnedBy: ROOT,
  status: EAgentStatus.Finished,
  endedAt: ago(HOUR_MS),
  deliveredAt: ago(HOUR_MS),
  lastViewedAt: null,
  ...over,
})

const standingOf = (args: {
  member: CrewMember
  crew?: readonly CrewMember[]
  viewing?: string | null
  now?: number
  graceMs?: number
}): ECrewStanding =>
  crewStanding({
    member: args.member,
    crew: args.crew ?? [args.member],
    viewing: args.viewing ?? null,
    now: args.now ?? NOW,
    graceMs: args.graceMs ?? GRACE_MS,
  })

describe('crewStanding', () => {
  it('reads a running child as live however stale its other marks are', () => {
    const running = member({
      status: EAgentStatus.Running,
      endedAt: ago(HOUR_MS),
      deliveredAt: ago(HOUR_MS),
      lastViewedAt: ago(HOUR_MS),
    })

    expect(standingOf({ member: running })).toBe(ECrewStanding.Live)
  })

  it('reads a blocked child as live', () => {
    expect(standingOf({ member: member({ status: EAgentStatus.Blocked }) })).toBe(ECrewStanding.Live)
  })

  it('retires a finished child whose result was delivered long ago', () => {
    expect(standingOf({ member: member() })).toBe(ECrewStanding.Retired)
  })

  it('holds an undelivered child however old it is', () => {
    const undelivered = member({ endedAt: ago(HOUR_MS * 12), deliveredAt: null })

    expect(standingOf({ member: undelivered })).toBe(ECrewStanding.Held)
  })

  it('holds the child being viewed', () => {
    expect(standingOf({ member: member(), viewing: CHILD })).toBe(ECrewStanding.Held)
  })

  it('restarts the grace clock when viewing ends', () => {
    const justLeft = member({ lastViewedAt: ago(1_000) })

    expect(standingOf({ member: justLeft, viewing: null })).toBe(ECrewStanding.Retiring)
  })

  it('holds an ancestor whose grandchild is still running', () => {
    const parent = member({ agentId: 'thr_parent', spawnedBy: ROOT })
    const child = member({ agentId: 'thr_middle', spawnedBy: 'thr_parent' })
    const grandchild = member({
      agentId: 'thr_grandchild',
      spawnedBy: 'thr_middle',
      status: EAgentStatus.Running,
      endedAt: null,
      deliveredAt: null,
    })
    const crew = [parent, child, grandchild]

    expect(standingOf({ member: parent, crew })).toBe(ECrewStanding.Held)
    expect(standingOf({ member: child, crew })).toBe(ECrewStanding.Held)
    expect(standingOf({ member: grandchild, crew })).toBe(ECrewStanding.Live)
  })

  it('does not let a live sibling hold a settled member', () => {
    const settled = member({ agentId: 'thr_settled' })
    const sibling = member({
      agentId: 'thr_sibling',
      status: EAgentStatus.Running,
      endedAt: null,
      deliveredAt: null,
    })

    expect(standingOf({ member: settled, crew: [settled, sibling] })).toBe(ECrewStanding.Retired)
  })

  it('holds an unacknowledged failure forever', () => {
    const failed = member({
      status: EAgentStatus.Failed,
      endedAt: ago(HOUR_MS * 12),
      deliveredAt: ago(HOUR_MS * 12),
      lastViewedAt: null,
    })

    expect(standingOf({ member: failed })).toBe(ECrewStanding.Held)
  })

  it('holds an unacknowledged stop forever', () => {
    expect(standingOf({ member: member({ status: EAgentStatus.Stopped }) })).toBe(
      ECrewStanding.Held,
    )
  })

  it('retires a failure once it has been read and released', () => {
    const acknowledged = member({
      status: EAgentStatus.Failed,
      lastViewedAt: ago(HOUR_MS),
    })

    expect(standingOf({ member: acknowledged })).toBe(ECrewStanding.Retired)
  })

  it('never retires a member whose end mark cannot be parsed', () => {
    const garbled = member({ endedAt: 'whenever' })

    expect(standingOf({ member: garbled })).toBe(ECrewStanding.Held)
  })

  it('never retires a member whose delivery mark cannot be parsed', () => {
    const garbled = member({ deliveredAt: 'soon' })

    expect(standingOf({ member: garbled })).toBe(ECrewStanding.Held)
  })

  it('never retires a member whose viewing mark cannot be parsed', () => {
    const garbled = member({ lastViewedAt: '' })

    expect(standingOf({ member: garbled })).toBe(ECrewStanding.Held)
  })

  it('never retires a terminal member that recorded no end', () => {
    expect(standingOf({ member: member({ endedAt: null }) })).toBe(ECrewStanding.Held)
  })

  it('is still retiring one ms before the grace elapses', () => {
    const ending = member({ endedAt: ago(GRACE_MS - 1), deliveredAt: ago(GRACE_MS - 1) })

    expect(standingOf({ member: ending })).toBe(ECrewStanding.Retiring)
  })

  it('retires exactly as the grace elapses', () => {
    const ending = member({ endedAt: ago(GRACE_MS), deliveredAt: ago(GRACE_MS) })

    expect(standingOf({ member: ending })).toBe(ECrewStanding.Retired)
  })

  it('retires one ms after the grace elapses', () => {
    const ending = member({ endedAt: ago(GRACE_MS + 1), deliveredAt: ago(GRACE_MS + 1) })

    expect(standingOf({ member: ending })).toBe(ECrewStanding.Retired)
  })

  it('counts the grace from the latest mark, not the earliest', () => {
    const lingering = member({
      endedAt: ago(HOUR_MS),
      deliveredAt: ago(HOUR_MS),
      lastViewedAt: ago(MINUTE_MS),
    })

    expect(standingOf({ member: lingering })).toBe(ECrewStanding.Retiring)
  })

  it('prefers delivery over an earlier end when the grace is counted', () => {
    const lateDelivery = member({ endedAt: ago(HOUR_MS), deliveredAt: ago(MINUTE_MS) })

    expect(standingOf({ member: lateDelivery })).toBe(ECrewStanding.Retiring)
  })
})

describe('partitionCrew', () => {
  const stale = member({ agentId: 'thr_stale' })

  const viewed = member({ agentId: 'thr_viewed' })

  const running = member({
    agentId: 'thr_running',
    status: EAgentStatus.Running,
    endedAt: null,
    deliveredAt: null,
  })

  const crew = [stale, viewed, running]

  it('splits the crew in input order', () => {
    const { shown, retired } = partitionCrew({
      crew,
      viewing: 'thr_viewed',
      now: NOW,
      graceMs: GRACE_MS,
    })

    expect(shown.map((row) => row.agentId)).toEqual(['thr_viewed', 'thr_running'])
    expect(retired.map((row) => row.agentId)).toEqual(['thr_stale'])
  })

  it('reports the standing it decided for every member', () => {
    const { standings } = partitionCrew({
      crew,
      viewing: 'thr_viewed',
      now: NOW,
      graceMs: GRACE_MS,
    })

    expect(standings.get('thr_stale')).toBe(ECrewStanding.Retired)
    expect(standings.get('thr_viewed')).toBe(ECrewStanding.Held)
    expect(standings.get('thr_running')).toBe(ECrewStanding.Live)
  })

  it('agrees with the single-member decision', () => {
    const { standings } = partitionCrew({ crew, viewing: null, now: NOW, graceMs: GRACE_MS })

    for (const row of crew) {
      expect(standings.get(row.agentId)).toBe(standingOf({ member: row, crew, viewing: null }))
    }
  })

  it('keeps a crew that carries no retirees whole', () => {
    const { shown, retired } = partitionCrew({
      crew: [running],
      viewing: null,
      now: NOW,
      graceMs: GRACE_MS,
    })

    expect(shown).toEqual([running])
    expect(retired).toEqual([])
  })

  it('survives a crew whose parent chain loops', () => {
    const first = member({ agentId: 'thr_first', spawnedBy: 'thr_second' })
    const second = member({
      agentId: 'thr_second',
      spawnedBy: 'thr_first',
      status: EAgentStatus.Running,
      endedAt: null,
      deliveredAt: null,
    })

    const { shown, retired } = partitionCrew({
      crew: [first, second],
      viewing: null,
      now: NOW,
      graceMs: GRACE_MS,
    })

    expect(shown.map((row) => row.agentId)).toEqual(['thr_first', 'thr_second'])
    expect(retired).toEqual([])
  })
})

describe('DEFAULT_CREW_GRACE_MS', () => {
  it('gives peripheral chrome three minutes', () => {
    expect(DEFAULT_CREW_GRACE_MS).toBe(3 * MINUTE_MS)
  })
})
