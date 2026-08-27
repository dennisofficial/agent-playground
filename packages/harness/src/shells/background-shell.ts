import { EShellStatus, type ClockPort } from '@dltech/atlas-core'

import { createOutputBuffer, type OutputDelta } from './output-buffer'
import { looksLikePrompt } from './prompt-sniff'
import type { ShellId } from './shell-id'
import {
  drainInto,
  messageOf,
  startShell,
  terminatorFor,
  withinReadGrace,
  type Drain,
  type Shell,
} from './shell-process'

export { EShellStatus }

const SNIFFED_TAIL_CHARACTERS = 240

export type ShellSnapshot = {
  shellId: ShellId
  command: string
  description?: string | undefined
  status: EShellStatus
  pid: number
  exitCode?: number | undefined
  startedAt: string
  lastOutputAt: string
  endedAt?: string | undefined
  totalCharacters: number
  awaitingInput: boolean
}

export type BackgroundShell = {
  readonly shellId: ShellId
  snapshot(): ShellSnapshot
  since(offset: number): OutputDelta
  tail(limit: number): string
  kill(): void
  exited: Promise<void>
}

export type StartedBackgroundShell =
  | { ok: true; shell: BackgroundShell }
  | { ok: false; reason: string }

export type BackgroundShellSpec = {
  shellId: ShellId
  command: string
  description?: string | undefined
  cwd: string
  clock: ClockPort
  retainCharacters: number
  overflowCharacters: number
  onExit: (shell: BackgroundShell) => void
}

function stopReading(drains: readonly Drain[]): void {
  for (const drain of drains) drain.stop()
}

async function awaitOutputThrough(args: { shell: Shell; drains: readonly Drain[] }): Promise<number> {
  const exitCode = await args.shell.exited
  await withinReadGrace(Promise.all(args.drains.map((drain) => drain.done)))
  stopReading(args.drains)
  return exitCode
}

export function startBackgroundShell(spec: BackgroundShellSpec): StartedBackgroundShell {
  const started = startShell({ command: spec.command, cwd: spec.cwd })
  if (!started.ok) return started

  const { shell } = started
  const buffer = createOutputBuffer({ retain: spec.retainCharacters })
  const terminate = terminatorFor(shell)
  const startedAt = spec.clock.now()

  let status = EShellStatus.Running
  let lastOutputAt = startedAt
  let exitCode: number | undefined
  let endedAt: string | undefined

  const drains: Drain[] = []

  const kill = (): void => {
    if (status !== EShellStatus.Running) return
    status = EShellStatus.Killed
    terminate()
  }

  const overflow = (): void => {
    if (status !== EShellStatus.Running) return
    status = EShellStatus.Overflowed
    terminate()
    stopReading(drains)
  }

  const append = (chunk: string): void => {
    if (chunk === '') return
    buffer.append(chunk)
    lastOutputAt = spec.clock.now()
    if (buffer.totalCharacters() > spec.overflowCharacters) overflow()
  }

  drains.push(
    drainInto({ stream: shell.stdout, append }),
    drainInto({ stream: shell.stderr, append }),
  )

  const settled = (async () => {
    try {
      exitCode = await awaitOutputThrough({ shell, drains })
    } catch (error) {
      append(`\natlas could not read this shell to the end: ${messageOf(error)}\n`)
    } finally {
      endedAt = spec.clock.now()
      if (status === EShellStatus.Running) status = EShellStatus.Exited
    }
  })()

  const self: BackgroundShell = {
    shellId: spec.shellId,

    snapshot: () => ({
      shellId: spec.shellId,
      command: spec.command,
      description: spec.description,
      status,
      pid: shell.pid,
      exitCode,
      startedAt,
      lastOutputAt,
      endedAt,
      totalCharacters: buffer.totalCharacters(),
      awaitingInput:
        status === EShellStatus.Running && looksLikePrompt(buffer.tail(SNIFFED_TAIL_CHARACTERS)),
    }),

    since: (offset) => buffer.since(offset),
    tail: (limit) => buffer.tail(limit),
    kill,

    exited: settled.then(() => {
      try {
        spec.onExit(self)
      } catch {
        return
      }
    }),
  }

  return { ok: true, shell: self }
}
