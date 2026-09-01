import { EShellStatus } from '@dltech/atlas-core'
import { toShellId, type ShellSnapshot } from '@dltech/atlas-harness'
import { describe, expect, it } from 'bun:test'

import { ECrewStanding, DEFAULT_CREW_GRACE_MS } from '../crew-retirement'
import { NO_VISITS } from '../crew-visits'
import {
  foldShells,
  partitionShells,
  shellGraceIsRunning,
  shellStanding,
  type ShellMember,
} from '../shell-retirement'

const NOW = Date.parse('2026-01-01T12:00:00.000Z')

const MINUTE_MS = 60_000

const HOUR_MS = 60 * MINUTE_MS

const GRACE_MS = 3 * MINUTE_MS

const ago = (ms: number): string => new Date(NOW - ms).toISOString()

const SHELL = 'sh_build'

const shell = (over: Partial<ShellMember> = {}): ShellMember => ({
  shellId: SHELL,
  status: EShellStatus.Exited,
  exitCode: 0,
  awaitingInput: false,
  endedAt: ago(HOUR_MS),
  lastViewedAt: null,
  ...over,
})

const standingOf = (args: {
  shell: ShellMember
  viewing?: string | null
  now?: number
  graceMs?: number
}): ECrewStanding =>
  shellStanding({
    shell: args.shell,
    viewing: args.viewing ?? null,
    now: args.now ?? NOW,
    graceMs: args.graceMs ?? GRACE_MS,
  })

describe('shellStanding', () => {
  it('reads a running shell as live however stale its other marks are', () => {
    const running = shell({
      status: EShellStatus.Running,
      endedAt: ago(HOUR_MS),
      lastViewedAt: ago(HOUR_MS),
    })

    expect(standingOf({ shell: running })).toBe(ECrewStanding.Live)
  })

  it('reads a running shell at a prompt as live rather than held', () => {
    const asking = shell({ status: EShellStatus.Running, awaitingInput: true, endedAt: null })

    expect(standingOf({ shell: asking })).toBe(ECrewStanding.Live)
  })

  it('holds a shell that is waiting on a human, whatever its status says', () => {
    const prompting = shell({ awaitingInput: true, lastViewedAt: ago(HOUR_MS) })

    expect(standingOf({ shell: prompting })).toBe(ECrewStanding.Held)
  })

  it('holds a shell waiting on a human over a clean exit the grace has outlived', () => {
    const prompting = shell({
      status: EShellStatus.Exited,
      exitCode: 0,
      awaitingInput: true,
      endedAt: ago(HOUR_MS),
      lastViewedAt: ago(HOUR_MS),
    })

    expect(standingOf({ shell: prompting })).toBe(ECrewStanding.Held)
  })

  it('holds the shell the operator is reading right now', () => {
    expect(standingOf({ shell: shell({ lastViewedAt: ago(HOUR_MS) }), viewing: SHELL })).toBe(
      ECrewStanding.Held,
    )
  })

  it('holds a non-zero exit nobody has opened', () => {
    expect(standingOf({ shell: shell({ exitCode: 2 }) })).toBe(ECrewStanding.Held)
  })

  it('holds a killed shell nobody has opened', () => {
    const killed = shell({ status: EShellStatus.Killed, exitCode: null })

    expect(standingOf({ shell: killed })).toBe(ECrewStanding.Held)
  })

  it('holds an overflowed shell nobody has opened', () => {
    const drowned = shell({ status: EShellStatus.Overflowed, exitCode: null })

    expect(standingOf({ shell: drowned })).toBe(ECrewStanding.Held)
  })

  it('retires a failure once the operator has read it and the grace has run', () => {
    const acknowledged = shell({ exitCode: 2, lastViewedAt: ago(HOUR_MS) })

    expect(standingOf({ shell: acknowledged })).toBe(ECrewStanding.Retired)
  })

  it('retires a clean exit nobody ever opened once the grace has run', () => {
    expect(standingOf({ shell: shell() })).toBe(ECrewStanding.Retired)
  })

  it('keeps a clean exit on screen while its grace is still running', () => {
    const fresh = shell({ endedAt: ago(MINUTE_MS) })

    expect(standingOf({ shell: fresh })).toBe(ECrewStanding.Retiring)
  })

  it('is still retiring one millisecond short of the grace', () => {
    const nearly = shell({ endedAt: ago(GRACE_MS - 1) })

    expect(standingOf({ shell: nearly })).toBe(ECrewStanding.Retiring)
  })

  it('retires exactly on the grace boundary', () => {
    const due = shell({ endedAt: ago(GRACE_MS) })

    expect(standingOf({ shell: due })).toBe(ECrewStanding.Retired)
  })

  it('retires one millisecond past the grace', () => {
    const past = shell({ endedAt: ago(GRACE_MS + 1) })

    expect(standingOf({ shell: past })).toBe(ECrewStanding.Retired)
  })

  it('starts the grace at the last reading rather than at the exit', () => {
    const reread = shell({ endedAt: ago(HOUR_MS), lastViewedAt: ago(MINUTE_MS) })

    expect(standingOf({ shell: reread })).toBe(ECrewStanding.Retiring)
  })

  it('starts the grace at the exit when that is the later of the two', () => {
    const viewedFirst = shell({ endedAt: ago(MINUTE_MS), lastViewedAt: ago(HOUR_MS) })

    expect(standingOf({ shell: viewedFirst })).toBe(ECrewStanding.Retiring)
  })

  it('holds a terminal shell that recorded no ending at all', () => {
    expect(standingOf({ shell: shell({ endedAt: null }) })).toBe(ECrewStanding.Held)
  })

  it('holds a shell whose ending will not parse', () => {
    expect(standingOf({ shell: shell({ endedAt: 'whenever' }) })).toBe(ECrewStanding.Held)
  })

  it('holds a shell whose last reading will not parse', () => {
    const garbled = shell({ endedAt: ago(HOUR_MS), lastViewedAt: 'the other day' })

    expect(standingOf({ shell: garbled })).toBe(ECrewStanding.Held)
  })

  it('measures the default grace in minutes rather than milliseconds', () => {
    const inside = shell({ endedAt: ago(DEFAULT_CREW_GRACE_MS - MINUTE_MS) })
    const outside = shell({ endedAt: ago(DEFAULT_CREW_GRACE_MS + MINUTE_MS) })

    expect(standingOf({ shell: inside, graceMs: DEFAULT_CREW_GRACE_MS })).toBe(
      ECrewStanding.Retiring,
    )
    expect(standingOf({ shell: outside, graceMs: DEFAULT_CREW_GRACE_MS })).toBe(
      ECrewStanding.Retired,
    )
  })
})

describe('partitionShells', () => {
  it('sets the retired aside and keeps everything the policy still holds', () => {
    const live = shell({ shellId: 'sh_live', status: EShellStatus.Running, endedAt: null })
    const held = shell({ shellId: 'sh_held', exitCode: 9 })
    const gone = shell({ shellId: 'sh_gone' })

    const { shown, retired, standings } = partitionShells({
      shells: [live, held, gone],
      viewing: null,
      now: NOW,
      graceMs: GRACE_MS,
    })

    expect(shown.map((one) => one.shellId)).toEqual(['sh_live', 'sh_held'])
    expect(retired.map((one) => one.shellId)).toEqual(['sh_gone'])
    expect(standings.get('sh_live')).toBe(ECrewStanding.Live)
    expect(standings.get('sh_held')).toBe(ECrewStanding.Held)
    expect(standings.get('sh_gone')).toBe(ECrewStanding.Retired)
  })

  it('keeps the shell being read out of the retired pile', () => {
    const gone = shell({ shellId: 'sh_gone' })

    const { shown, retired } = partitionShells({
      shells: [gone],
      viewing: 'sh_gone',
      now: NOW,
      graceMs: GRACE_MS,
    })

    expect(shown.map((one) => one.shellId)).toEqual(['sh_gone'])
    expect(retired).toHaveLength(0)
  })
})

const snapshotOf = (over: {
  shellId: string
  status?: EShellStatus
  exitCode?: number
  awaitingInput?: boolean
  endedAt?: string
}): ShellSnapshot => ({
  shellId: toShellId(over.shellId),
  command: `run ${over.shellId}`,
  description: over.shellId,
  status: over.status ?? EShellStatus.Exited,
  pid: 4242,
  startedAt: ago(HOUR_MS),
  lastOutputAt: ago(HOUR_MS),
  totalCharacters: 24,
  awaitingInput: over.awaitingInput ?? false,
  exitCode: over.exitCode ?? 0,
  ...(over.endedAt === undefined ? {} : { endedAt: over.endedAt }),
})

const reckoning = (shells: readonly ShellSnapshot[]) => ({
  shells,
  visits: NO_VISITS,
  viewing: null,
  now: NOW,
  graceMs: GRACE_MS,
})

describe('shellGraceIsRunning', () => {
  it('says nothing is counting when the panel is empty', () => {
    expect(shellGraceIsRunning(reckoning([]))).toBe(false)
  })

  it('counts while a clean exit is still inside its window', () => {
    const fresh = snapshotOf({ shellId: 'sh_fresh', endedAt: ago(MINUTE_MS) })

    expect(shellGraceIsRunning(reckoning([fresh]))).toBe(true)
  })

  it('stops counting once every window has run out', () => {
    const gone = snapshotOf({ shellId: 'sh_gone', endedAt: ago(HOUR_MS) })
    const running = snapshotOf({ shellId: 'sh_live', status: EShellStatus.Running })

    expect(shellGraceIsRunning(reckoning([gone, running]))).toBe(false)
  })
})

describe('foldShells', () => {
  it('drops a retired shell and reports what it let go of', () => {
    const held = snapshotOf({ shellId: 'sh_held', exitCode: 9, endedAt: ago(HOUR_MS) })
    const gone = snapshotOf({ shellId: 'sh_gone', endedAt: ago(HOUR_MS) })

    const fold = foldShells({ ...reckoning([held, gone]), cap: 3 })

    expect(fold.shown.map((shell) => String(shell.shellId))).toEqual(['sh_held'])
    expect(fold.hidden).toBe(1)
    expect(fold.hiddenFailed).toBe(false)
  })

  it('says a failure was among the ones it let go of', () => {
    const failed = snapshotOf({ shellId: 'sh_bad', exitCode: 3, endedAt: ago(HOUR_MS) })

    const fold = foldShells({
      shells: [failed],
      visits: new Map([['sh_bad', ago(HOUR_MS)]]),
      viewing: null,
      now: NOW,
      graceMs: GRACE_MS,
      cap: 3,
    })

    expect(fold.shown).toHaveLength(0)
    expect(fold.hidden).toBe(1)
    expect(fold.hiddenFailed).toBe(true)
  })

  it('caps the retiring rows without ever capping the held ones', () => {
    const held = [1, 2, 3, 4].map((n) =>
      snapshotOf({ shellId: `sh_held_${n}`, exitCode: n, endedAt: ago(HOUR_MS) }),
    )
    const retiring = [1, 2, 3].map((n) =>
      snapshotOf({ shellId: `sh_soon_${n}`, endedAt: ago(MINUTE_MS) }),
    )

    const fold = foldShells({ ...reckoning([...held, ...retiring]), cap: 1 })

    expect(fold.shown.map((shell) => String(shell.shellId))).toEqual([
      'sh_held_1',
      'sh_held_2',
      'sh_held_3',
      'sh_held_4',
      'sh_soon_3',
    ])
    expect(fold.hidden).toBe(2)
  })
})
