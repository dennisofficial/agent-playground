import { EShellStatus, quotedShellCommand } from '@dltech/atlas-core'

export type ShellEnding = {
  command: string
  description?: string | undefined
  status: EShellStatus
  exitCode?: number | undefined
}

const named = (ending: ShellEnding): string => {
  const description = ending.description?.trim() ?? ''
  return description === '' ? quotedShellCommand(ending.command) : `"${description}"`
}

function outcomeOf(ending: ShellEnding): string {
  if (ending.status === EShellStatus.Killed) return 'was killed'
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
