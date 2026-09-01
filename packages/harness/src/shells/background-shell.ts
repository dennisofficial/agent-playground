import { EKilledBy, EShellStatus, type ClockPort } from '@dltech/atlas-core'

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

export { EKilledBy, EShellStatus }

const SNIFFED_TAIL_CHARACTERS = 240

export type ShellSnapshot = {
  shellId: ShellId
  command: string
  description: string
  status: EShellStatus
  killedBy?: EKilledBy | undefined
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
  kill(by: EKilledBy): void
  exited: Promise<void>
}

export type StartedBackgroundShell =
  | { ok: true; shell: BackgroundShell }
  | { ok: false; reason: string }

export type BackgroundShellSpec = {
  shellId: ShellId
  command: string
  description: string
  cwd: string
  clock: ClockPort
  retainCharacters: number
  overflowCharacters: number
  promptSettleMs: number
  onExit: (shell: BackgroundShell) => void
  onAwaitingInput: (shell: BackgroundShell) => void
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
  let killedBy: EKilledBy | undefined
  let lastOutputAt = startedAt
  let exitCode: number | undefined
  let endedAt: string | undefined
  let awaitingSettled = false
  let awaitingAnnounced = false
  let promptWatch: ReturnType<typeof setTimeout> | undefined

  const drains: Drain[] = []

  const forgetPromptWatch = (): void => {
    if (promptWatch !== undefined) clearTimeout(promptWatch)
    promptWatch = undefined
  }

  const atAPrompt = (): boolean =>
    status === EShellStatus.Running && looksLikePrompt(buffer.tail(SNIFFED_TAIL_CHARACTERS))

  /**
   * The sniff fires on output that has no trailing newline, which every chunk arriving mid-line
   * satisfies for as long as it takes the rest of the line to show up. Only a tail that stays put
   * is a prompt, so the claim is made after the shell has been quiet, never on the chunk itself.
   */
  const settlePrompt = (): void => {
    promptWatch = undefined
    if (!atAPrompt()) return

    awaitingSettled = true
    if (awaitingAnnounced) return

    awaitingAnnounced = true
    try {
      spec.onAwaitingInput(self)
    } catch {
      return
    }
  }

  const watchForPrompt = (): void => {
    forgetPromptWatch()
    if (!atAPrompt()) return

    promptWatch = setTimeout(settlePrompt, spec.promptSettleMs)
    promptWatch.unref?.()
  }

  const kill = (by: EKilledBy): void => {
    if (status !== EShellStatus.Running) return
    status = EShellStatus.Killed
    killedBy = by
    forgetPromptWatch()
    terminate()
  }

  const overflow = (): void => {
    if (status !== EShellStatus.Running) return
    status = EShellStatus.Overflowed
    forgetPromptWatch()
    terminate()
    stopReading(drains)
  }

  const append = (chunk: string): void => {
    if (chunk === '') return
    buffer.append(chunk)
    lastOutputAt = spec.clock.now()
    awaitingSettled = false
    if (buffer.totalCharacters() > spec.overflowCharacters) return overflow()

    watchForPrompt()
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
      forgetPromptWatch()
      awaitingSettled = false
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
      killedBy,
      pid: shell.pid,
      exitCode,
      startedAt,
      lastOutputAt,
      endedAt,
      totalCharacters: buffer.totalCharacters(),
      awaitingInput: status === EShellStatus.Running && awaitingSettled,
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
