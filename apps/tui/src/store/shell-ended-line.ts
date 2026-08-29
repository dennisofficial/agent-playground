import { EKilledBy, EShellStatus, quotedShellCommand } from '@dltech/atlas-core'

export type ShellEnding = {
  command: string
  description?: string | undefined
  status: EShellStatus
  killedBy?: EKilledBy | undefined
  exitCode?: number | undefined
}

const named = (ending: ShellEnding): string => {
  const description = ending.description?.trim() ?? ''
  return description === '' ? quotedShellCommand(ending.command) : `"${description}"`
}

const killedOutcome = (killedBy: EKilledBy | undefined): string => {
  if (killedBy === EKilledBy.User) return 'was killed by you'
  if (killedBy === EKilledBy.Model) return 'was killed by atlas'
  if (killedBy === EKilledBy.SessionEnd) return 'was killed when the session closed'
  return 'was killed'
}

function outcomeOf(ending: ShellEnding): string {
  if (ending.status === EShellStatus.Killed) return killedOutcome(ending.killedBy)
  if (ending.status === EShellStatus.Overflowed) return 'was killed for printing too much'
  if (ending.exitCode === undefined) return 'ended'
  if (ending.exitCode === 0) return 'completed (exit code 0)'
  return `failed (exit code ${ending.exitCode})`
}

export const shellEndedLine = (ending: ShellEnding): string =>
  `Background shell ${named(ending)} ${outcomeOf(ending)}`

export const shellEndingFailed = (ending: ShellEnding): boolean =>
  ending.status === EShellStatus.Overflowed ||
  (ending.exitCode !== undefined && ending.exitCode !== 0)
