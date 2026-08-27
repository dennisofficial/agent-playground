export enum EShellStatus {
  Running = 'running',
  Exited = 'exited',
  Killed = 'killed',
  Overflowed = 'overflowed',
}

export type ShellEnding = {
  status: EShellStatus
  exitCode?: number | undefined
  totalCharacters?: number | undefined
}

export function shellFailed(ending: ShellEnding): boolean {
  if (ending.status === EShellStatus.Overflowed) return true
  if (ending.status === EShellStatus.Killed) return false
  return ending.exitCode !== undefined && ending.exitCode !== 0
}

export function shellEnding(ending: ShellEnding): string {
  if (ending.status === EShellStatus.Killed) return 'was killed'
  if (ending.status === EShellStatus.Overflowed) {
    return `was killed for printing more than ${ending.totalCharacters ?? 0} characters`
  }
  if (ending.exitCode === undefined) return 'has finished'
  if (ending.exitCode === 0) return 'finished successfully'
  return `failed with exit code ${ending.exitCode}`
}
