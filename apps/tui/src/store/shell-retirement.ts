import { EShellStatus } from '@dltech/atlas-core'
import type { ShellSnapshot } from '@dltech/atlas-harness'

import { foldCrew, type CrewFold } from './crew-fold'
import { ECrewStanding } from './crew-retirement'
import { lastVisitOf, type CrewVisits } from './crew-visits'

export type ShellMember = {
  shellId: string
  status: EShellStatus
  exitCode: number | null
  awaitingInput: boolean
  endedAt: string | null
  lastViewedAt: string | null
}

const IS_TERMINAL: Record<EShellStatus, boolean> = {
  [EShellStatus.Running]: false,
  [EShellStatus.Exited]: true,
  [EShellStatus.Killed]: true,
  [EShellStatus.Overflowed]: true,
}

const ENDED_BADLY: Record<EShellStatus, boolean> = {
  [EShellStatus.Running]: false,
  [EShellStatus.Exited]: false,
  [EShellStatus.Killed]: true,
  [EShellStatus.Overflowed]: true,
}

const instantOf = (iso: string): number | null => {
  const at = Date.parse(iso)
  return Number.isNaN(at) ? null : at
}

export const shellWentWrong = (shell: Pick<ShellMember, 'status' | 'exitCode'>): boolean =>
  ENDED_BADLY[shell.status] || (shell.exitCode !== null && shell.exitCode !== 0)

const graceStartedAt = (shell: ShellMember): number | null => {
  if (shell.endedAt === null) return null

  const ended = instantOf(shell.endedAt)
  if (ended === null) return null
  if (shell.lastViewedAt === null) return ended

  const viewed = instantOf(shell.lastViewedAt)
  if (viewed === null) return null

  return Math.max(ended, viewed)
}

export function shellStanding(args: {
  shell: ShellMember
  viewing: string | null
  now: number
  graceMs: number
}): ECrewStanding {
  const { shell } = args
  if (!IS_TERMINAL[shell.status]) return ECrewStanding.Live
  if (shell.awaitingInput) return ECrewStanding.Held
  if (shell.shellId === args.viewing) return ECrewStanding.Held
  if (shell.lastViewedAt === null && shellWentWrong(shell)) return ECrewStanding.Held

  const since = graceStartedAt(shell)
  if (since === null) return ECrewStanding.Held

  return args.now - since >= args.graceMs ? ECrewStanding.Retired : ECrewStanding.Retiring
}

export type ShellPartition<TShell extends ShellMember> = {
  shown: readonly TShell[]
  retired: readonly TShell[]
  standings: ReadonlyMap<string, ECrewStanding>
}

export function partitionShells<TShell extends ShellMember>(args: {
  shells: readonly TShell[]
  viewing: string | null
  now: number
  graceMs: number
}): ShellPartition<TShell> {
  const shown: TShell[] = []
  const retired: TShell[] = []
  const standings = new Map<string, ECrewStanding>()

  for (const shell of args.shells) {
    const standing = shellStanding({
      shell,
      viewing: args.viewing,
      now: args.now,
      graceMs: args.graceMs,
    })

    standings.set(shell.shellId, standing)
    if (standing === ECrewStanding.Retired) retired.push(shell)
    else shown.push(shell)
  }

  return { shown, retired, standings }
}

const shellMembersOf = (args: {
  shells: readonly ShellSnapshot[]
  visits: CrewVisits
}): readonly ShellMember[] =>
  args.shells.map((shell) => ({
    shellId: shell.shellId,
    status: shell.status,
    exitCode: shell.exitCode ?? null,
    awaitingInput: shell.awaitingInput,
    endedAt: shell.endedAt ?? null,
    lastViewedAt: lastVisitOf({ visits: args.visits, id: shell.shellId }),
  }))

export type ShellReckoning = {
  shells: readonly ShellSnapshot[]
  visits: CrewVisits
  viewing: string | null
  now: number
  graceMs: number
}

export function shellGraceIsRunning(args: ShellReckoning): boolean {
  if (args.shells.length === 0) return false

  const { standings } = partitionShells({
    shells: shellMembersOf(args),
    viewing: args.viewing,
    now: args.now,
    graceMs: args.graceMs,
  })

  for (const standing of standings.values()) {
    if (standing === ECrewStanding.Retiring) return true
  }

  return false
}

export function foldShells(args: ShellReckoning & { cap: number }): CrewFold<ShellSnapshot> {
  const { standings } = partitionShells({
    shells: shellMembersOf(args),
    viewing: args.viewing,
    now: args.now,
    graceMs: args.graceMs,
  })

  return foldCrew({
    rows: args.shells,
    keyOf: (shell) => shell.shellId,
    standings,
    cap: args.cap,
    wentWrong: (shell) =>
      shellWentWrong({ status: shell.status, exitCode: shell.exitCode ?? null }),
  })
}
