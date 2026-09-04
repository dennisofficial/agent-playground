import {
  ProcessPort,
  type PortExposureOutcome,
  type ProcessHandle,
  type SpawnCommand,
} from '@dltech/atlas-core'

export const SIGKILL_GRACE_MS = 5_000

export type LocalProcessHandle = ProcessHandle & { readonly pid: number }

type PipedSubprocess = Bun.Subprocess<'ignore', 'pipe', 'pipe'>

export type Signalable = { pid: number; kill(signal: 'SIGTERM' | 'SIGKILL'): unknown }

/**
 * setsid(2) makes the spawned process a process group leader, so a negative pid signals the whole
 * group. Signalling only the leader would strand every process it forked: those are reparented to
 * init the moment it dies, which puts them out of reach of any later kill.
 */
export const signalGroup = (args: { child: Signalable; signal: 'SIGTERM' | 'SIGKILL' }): void => {
  try {
    process.kill(-args.child.pid, args.signal)
  } catch {
    try {
      args.child.kill(args.signal)
    } catch {
      return
    }
  }
}

const handleFor = (child: PipedSubprocess): LocalProcessHandle => {
  let fired = false

  return {
    pid: child.pid,
    stdout: child.stdout,
    stderr: child.stderr,
    exited: child.exited,
    terminate: () => {
      if (fired) return
      fired = true
      signalGroup({ child, signal: 'SIGTERM' })
      setTimeout(() => signalGroup({ child, signal: 'SIGKILL' }), SIGKILL_GRACE_MS).unref()
    },
  }
}

export class LocalProcessPort implements ProcessPort {
  async exposePort(args: { containerPort: number }): Promise<PortExposureOutcome> {
    return {
      ok: true,
      exposure: {
        containerPort: args.containerPort,
        hostPort: args.containerPort,
        url: `http://localhost:${args.containerPort}`,
      },
    }
  }

  spawn(args: SpawnCommand): LocalProcessHandle {
    return handleFor(
      Bun.spawn({
        cmd: [...args.cmd],
        cwd: args.cwd,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        detached: true,
        ...(args.env === undefined ? {} : { env: args.env }),
      }),
    )
  }

  /**
   * Bun.which resolves against the PATH captured when the process started and ignores later writes
   * to process.env.PATH unless the PATH option is passed explicitly.
   * https://bun.sh/docs/api/utils#bun-which
   */
  which(args: { command: string }): string | null {
    const path = process.env.PATH
    return path === undefined ? Bun.which(args.command) : Bun.which(args.command, { PATH: path })
  }
}
