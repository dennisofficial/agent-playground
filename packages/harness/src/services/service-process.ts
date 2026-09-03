import { closeSync, mkdirSync, openSync, readSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

import {
  EKilledBy,
  EServiceStatus,
  EStopAction,
  stopActionFor,
  type ClockPort,
} from '@dltech/atlas-core'

import { messageOf, signalGroup } from '../shells/shell-process'
import { atlasBinDirectory } from '../store/paths'

export const SERVICE_SETTLE_MS = 250

export type ServiceSnapshot = {
  serviceId: string
  command: string
  description: string
  status: EServiceStatus
  killedBy?: EKilledBy | undefined
  pid: number
  exitCode?: number | undefined
  logPath: string
  startedAt: string
  endedAt?: string | undefined
}

export type Service = {
  readonly serviceId: string
  readonly logPath: string
  snapshot(): ServiceSnapshot
  stop(by: EKilledBy): EStopAction
  exited: Promise<void>
}

export type StartedService = { ok: true; service: Service } | { ok: false; reason: string }

/**
 * A service's output is a file, not a buffer: a dev server prints unboundedly for hours, and the
 * model reads the log with the file tools it already has. Both streams share one append-mode fd so
 * their interleaving in the log matches their interleaving in time.
 */
export function startService(spec: {
  serviceId: string
  command: string
  description: string
  cwd: string
  logPath: string
  clock: ClockPort
  onExit: (service: Service) => void
}): StartedService {
  let fd: number
  try {
    mkdirSync(dirname(spec.logPath), { recursive: true })
    fd = openSync(spec.logPath, 'a')
  } catch (error) {
    return {
      ok: false,
      reason: `could not open the service log at ${spec.logPath}: ${messageOf(error)}`,
    }
  }

  let child: ReturnType<typeof Bun.spawn>
  try {
    child = Bun.spawn({
      cmd: ['bash', '-c', spec.command],
      cwd: spec.cwd,
      stdin: 'ignore',
      stdout: fd,
      stderr: fd,
      detached: true,
      env: { ...process.env, PATH: `${atlasBinDirectory()}:${process.env.PATH ?? ''}` },
    })
  } catch (error) {
    closeSync(fd)
    return { ok: false, reason: `could not start a service in ${spec.cwd}: ${messageOf(error)}` }
  }
  closeSync(fd)
  child.unref()

  const startedAt = spec.clock.now()
  let status = EServiceStatus.Running
  let killedBy: EKilledBy | undefined
  let exitCode: number | undefined
  let endedAt: string | undefined
  let stopSignalled = false

  const stop = (by: EKilledBy): EStopAction => {
    const action = stopActionFor({ status, exitCode, stopSignalled })
    if (action === EStopAction.Gone) return action

    stopSignalled = true
    if (status === EServiceStatus.Running) {
      status = EServiceStatus.Killed
      killedBy = by
    }
    signalGroup({ child, signal: action === EStopAction.Kill ? 'SIGKILL' : 'SIGTERM' })
    return action
  }

  const settled = (async () => {
    try {
      exitCode = await child.exited
    } catch {
      exitCode = undefined
    } finally {
      endedAt = spec.clock.now()
      if (status === EServiceStatus.Running) status = EServiceStatus.Exited
    }
  })()

  const self: Service = {
    serviceId: spec.serviceId,
    logPath: spec.logPath,

    snapshot: () => ({
      serviceId: spec.serviceId,
      command: spec.command,
      description: spec.description,
      status,
      killedBy,
      pid: child.pid,
      exitCode,
      logPath: spec.logPath,
      startedAt,
      endedAt,
    }),

    stop,

    exited: settled.then(() => {
      try {
        spec.onExit(self)
      } catch {
        return
      }
    }),
  }

  return { ok: true, service: self }
}

export function logTail(args: { path: string; characters: number }): string {
  try {
    const size = statSync(args.path).size
    const start = Math.max(0, size - args.characters)
    const fd = openSync(args.path, 'r')
    try {
      const buffer = Buffer.alloc(size - start)
      readSync(fd, buffer, 0, buffer.length, start)
      return buffer.toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
}
