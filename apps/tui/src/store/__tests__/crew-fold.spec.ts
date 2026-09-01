import { EAgentStatus } from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import { DEFAULT_CREW_CAP, foldCrew } from '../crew-fold'
import { ECrewStanding } from '../crew-retirement'

const row = (id: string, status: EAgentStatus): Row => ({ id, status })

type Row = { id: string; status: EAgentStatus }

const WENT_WRONG: Record<EAgentStatus, boolean> = {
  [EAgentStatus.Running]: false,
  [EAgentStatus.Blocked]: false,
  [EAgentStatus.Finished]: false,
  [EAgentStatus.Failed]: true,
  [EAgentStatus.Stopped]: true,
}

const wentWrong = (one: Row): boolean => WENT_WRONG[one.status]

const keyOf = (one: Row): string => one.id

const RUNNING = row('running', EAgentStatus.Running)

const HELD = row('held', EAgentStatus.Finished)

const FAILED = row('failed', EAgentStatus.Failed)

const standings = (
  entries: readonly (readonly [string, ECrewStanding])[],
): ReadonlyMap<string, ECrewStanding> => new Map(entries)

const retiring = (count: number): readonly Row[] =>
  Array.from({ length: count }, (_, at) => row(`settled-${at}`, EAgentStatus.Finished))

const allRetiring = (rows: readonly Row[]): ReadonlyMap<string, ECrewStanding> =>
  standings(rows.map((one) => [one.id, ECrewStanding.Retiring] as const))

describe('crew fold', () => {
  it('shows a live row whatever the cap', () => {
    const folded = foldCrew({
      rows: [RUNNING],
      standings: standings([[RUNNING.id, ECrewStanding.Live]]),
      cap: 0,
      wentWrong,
      keyOf,
    })

    expect(folded.shown).toEqual([RUNNING])
    expect(folded.hidden).toBe(0)
  })

  it('shows a held row whatever the cap', () => {
    const folded = foldCrew({
      rows: [HELD],
      standings: standings([[HELD.id, ECrewStanding.Held]]),
      cap: 0,
      wentWrong,
      keyOf,
    })

    expect(folded.shown).toEqual([HELD])
  })

  it('hides a retired row and counts it', () => {
    const folded = foldCrew({
      rows: [RUNNING, HELD],
      standings: standings([
        [RUNNING.id, ECrewStanding.Live],
        [HELD.id, ECrewStanding.Retired],
      ]),
      cap: DEFAULT_CREW_CAP,
      wentWrong,
      keyOf,
    })

    expect(folded.shown).toEqual([RUNNING])
    expect(folded.hidden).toBe(1)
  })

  it('caps the retiring rows and counts the overflow', () => {
    const rows = retiring(5)
    const folded = foldCrew({ rows, standings: allRetiring(rows), cap: 2, wentWrong, keyOf })

    expect(folded.shown).toHaveLength(2)
    expect(folded.hidden).toBe(3)
  })

  it('keeps the most recent of the retiring rows', () => {
    const rows = retiring(4)
    const folded = foldCrew({ rows, standings: allRetiring(rows), cap: 2, wentWrong, keyOf })

    expect(folded.shown.map((one) => one.id)).toEqual(['settled-2', 'settled-3'])
  })

  it('never caps out a held row to make room', () => {
    const rows = [HELD, ...retiring(3)]
    const folded = foldCrew({
      rows,
      standings: standings([
        [HELD.id, ECrewStanding.Held],
        ...retiring(3).map((one) => [one.id, ECrewStanding.Retiring] as const),
      ]),
      cap: 1,
      wentWrong,
      keyOf,
    })

    expect(folded.shown.map((one) => one.id)).toContain(HELD.id)
    expect(folded.shown).toHaveLength(2)
    expect(folded.hidden).toBe(2)
  })

  it('holds the crew whole when nothing is retired or capped', () => {
    const rows = [RUNNING, HELD]
    const folded = foldCrew({
      rows,
      standings: standings([
        [RUNNING.id, ECrewStanding.Live],
        [HELD.id, ECrewStanding.Held],
      ]),
      cap: DEFAULT_CREW_CAP,
      wentWrong,
      keyOf,
    })

    expect(folded.shown).toEqual(rows)
    expect(folded.hidden).toBe(0)
    expect(folded.hiddenFailed).toBe(false)
  })

  it('keeps the shown rows in the order it was given', () => {
    const rows = [retiring(1)[0] as Row, RUNNING]
    const folded = foldCrew({
      rows,
      standings: standings([
        ['settled-0', ECrewStanding.Retiring],
        [RUNNING.id, ECrewStanding.Live],
      ]),
      cap: DEFAULT_CREW_CAP,
      wentWrong,
      keyOf,
    })

    expect(folded.shown.map((one) => one.id)).toEqual(['settled-0', RUNNING.id])
  })

  it('says when a hidden row failed', () => {
    const folded = foldCrew({
      rows: [FAILED],
      standings: standings([[FAILED.id, ECrewStanding.Retired]]),
      cap: DEFAULT_CREW_CAP,
      wentWrong,
      keyOf,
    })

    expect(folded.hiddenFailed).toBe(true)
  })

  it('says when a hidden row was stopped', () => {
    const stopped = row('stopped', EAgentStatus.Stopped)
    const folded = foldCrew({
      rows: [stopped],
      standings: standings([[stopped.id, ECrewStanding.Retired]]),
      cap: DEFAULT_CREW_CAP,
      wentWrong,
      keyOf,
    })

    expect(folded.hiddenFailed).toBe(true)
  })

  it('stays quiet when the hidden rows all finished', () => {
    const rows = retiring(4)
    const folded = foldCrew({ rows, standings: allRetiring(rows), cap: 1, wentWrong, keyOf })

    expect(folded.hidden).toBe(3)
    expect(folded.hiddenFailed).toBe(false)
  })

  it('reads a row with no recorded standing as live', () => {
    const folded = foldCrew({ rows: [RUNNING], standings: standings([]), cap: 0, wentWrong, keyOf })

    expect(folded.shown).toEqual([RUNNING])
    expect(folded.hidden).toBe(0)
  })
})
