import { EKilledBy } from '../shells/status'

export enum EServiceStatus {
  Running = 'running',
  Exited = 'exited',
  Killed = 'killed',
}

export type ServiceEnding = {
  status: EServiceStatus
  exitCode?: number | undefined
  killedBy?: EKilledBy | undefined
}

export function serviceFailed(ending: ServiceEnding): boolean {
  if (ending.status === EServiceStatus.Killed) return false
  return ending.exitCode !== undefined && ending.exitCode !== 0
}

function killEnding(killedBy: EKilledBy | undefined): string {
  if (killedBy === EKilledBy.User) return 'was stopped by the user'
  if (killedBy === EKilledBy.Model) return 'was stopped at your request'
  if (killedBy === EKilledBy.SessionEnd) return 'was stopped because the session was closing'
  return 'was stopped'
}

export function serviceEnding(ending: ServiceEnding): string {
  if (ending.status === EServiceStatus.Killed) return killEnding(ending.killedBy)
  if (ending.exitCode === undefined) return 'exited'
  if (ending.exitCode === 0) return 'exited cleanly'
  return `exited with code ${ending.exitCode}`
}
