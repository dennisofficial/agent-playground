export enum EShellStatus {
  Running = 'running',
  Exited = 'exited',
  Killed = 'killed',
  Overflowed = 'overflowed',
}

export enum EKilledBy {
  User = 'user',
  Model = 'model',
  SessionEnd = 'session-end',
}

export type ShellEnding = {
  status: EShellStatus
  exitCode?: number | undefined
  totalCharacters?: number | undefined
  killedBy?: EKilledBy | undefined
}

export function shellFailed(ending: ShellEnding): boolean {
  if (ending.status === EShellStatus.Overflowed) return true
  if (ending.status === EShellStatus.Killed) return false
  return ending.exitCode !== undefined && ending.exitCode !== 0
}

function killEnding(killedBy: EKilledBy | undefined): string {
  if (killedBy === EKilledBy.User) return 'was killed by the user'
  if (killedBy === EKilledBy.Model) return 'was killed at your request'
  if (killedBy === EKilledBy.SessionEnd) return 'was killed because the session was closing'
  return 'was killed'
}

export function shellEnding(ending: ShellEnding): string {
  if (ending.status === EShellStatus.Killed) return killEnding(ending.killedBy)
  if (ending.status === EShellStatus.Overflowed) {
    return `was killed for printing more than ${ending.totalCharacters ?? 0} characters`
  }
  if (ending.exitCode === undefined) return 'has finished'
  if (ending.exitCode === 0) return 'finished successfully'
  return `failed with exit code ${ending.exitCode}`
}
