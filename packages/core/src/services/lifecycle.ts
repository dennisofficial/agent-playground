import { EServiceStatus } from './status'

export enum EStopAction {
  Term = 'term',
  Kill = 'kill',
  Gone = 'gone',
}

export type ServiceVital = {
  status: EServiceStatus
  exitCode?: number | undefined
  stopSignalled: boolean
}

/**
 * Liveness is not the display status: `killed` is recorded on signal delivery, not on death, and a
 * reaped pid can be reissued to a stranger — so nothing may signal past a confirmed death.
 */
export function mayStillBeAlive(entry: { status: EServiceStatus; exitCode?: number | undefined }): boolean {
  return entry.exitCode === undefined && entry.status !== EServiceStatus.Exited
}

/**
 * The first stop SIGTERMs; a service that ignored it gets SIGKILL on every stop after; one already
 * confirmed dead is answered in prose without signalling.
 */
export function stopActionFor(entry: ServiceVital): EStopAction {
  if (!mayStillBeAlive(entry)) return EStopAction.Gone
  return entry.stopSignalled ? EStopAction.Kill : EStopAction.Term
}
