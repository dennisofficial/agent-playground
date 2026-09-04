import {
  EKilledBy,
  EShellStatus,
  type ClockPort,
  type PortExposure,
  type ProcessPort,
  type ThreadId,
} from '@dltech/atlas-core'

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
import { createLineMatcher, type MatchedLines } from './shell-watch'

export { EKilledBy, EShellStatus }

const SNIFFED_TAIL_CHARACTERS = 240

export type ShellSnapshot = {
  shellId: ShellId
  command: string
  description: string
  status: EShellStatus
  killedBy?: EKilledBy | undefined
  pid?: number | undefined
  exitCode?: number | undefined
  startedAt: string
  lastOutputAt: string
  endedAt?: string | undefined
  totalCharacters: number
  awaitingInput: boolean
  exposure?: PortExposure | undefined
}

export type BackgroundShell = {
  readonly shellId: ShellId
  snapshot(): ShellSnapshot
  since(offset: number): OutputDelta
  tail(limit: number): string
  kill(by: EKilledBy): void
  release(): void
  exited: Promise<void>
}

export type StartedBackgroundShell =
  | { ok: true; shell: BackgroundShell }
  | { ok: false; reason: string }

export type StartShellArgs = {
  threadId: ThreadId
  command: string
  description: string
  cwd?: string | undefined
  watch?: string | undefined
  timeoutMs?: number | undefined
  checkInMs?: number | undefined
  exposure?: PortExposure | undefined
}

export type StartedShellOutcome = { ok: true; snapshot: ShellSnapshot } | { ok: false; reason: string }

export type ShellKillOutcome = { ok: true; snapshot: ShellSnapshot } | { ok: false; reason: string }

export type BackgroundShellSpec = {
  shellId: ShellId
  command: string
  description: string
  cwd: string
  threadId?: ThreadId | undefined
  clock: ClockPort
  retainCharacters: number
  overflowCharacters: number
  promptSettleMs: number
  watch?: RegExp | undefined
  matchSettleMs: number
  matchedLinesCap: number
  timeoutMs?: number | undefined
  checkInMs?: number | undefined
  exposure?: PortExposure | undefined
  processes?: ProcessPort | undefined
  onExit: (shell: BackgroundShell) => void
  onAwaitingInput: (shell: BackgroundShell) => void
  onMatched: (args: { shell: BackgroundShell; matched: MatchedLines }) => void
  onStillRunning: (shell: BackgroundShell) => void
  onActivity?: (() => void) | undefined
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
  const started = startShell({
    command: spec.command,
    cwd: spec.cwd,
    processes: spec.processes,
    threadId: spec.threadId,
  })
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
  let matchWatch: ReturnType<typeof setTimeout> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  let checkIn: ReturnType<typeof setTimeout> | undefined

  const drains: Drain[] = []

  const matcher =
    spec.watch === undefined
      ? undefined
      : createLineMatcher({ pattern: spec.watch, cap: spec.matchedLinesCap })

  const forgetPromptWatch = (): void => {
    if (promptWatch !== undefined) clearTimeout(promptWatch)
    promptWatch = undefined
  }

  const forgetMatchWatch = (): void => {
    if (matchWatch !== undefined) clearTimeout(matchWatch)
    matchWatch = undefined
  }

  const forgetDeadline = (): void => {
    if (deadline !== undefined) clearTimeout(deadline)
    deadline = undefined
  }

  const forgetCheckIn = (): void => {
    if (checkIn !== undefined) clearTimeout(checkIn)
    checkIn = undefined
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
    forgetCheckIn()
    terminate()
  }

  if (spec.timeoutMs !== undefined) {
    deadline = setTimeout(() => kill(EKilledBy.Timeout), spec.timeoutMs)
    deadline.unref?.()
  }

  /**
   * A check-in is paced from the start rather than re-armed on output: a poll loop that prints a
   * line a minute is not idle by any silence measure, yet it is exactly the shell nobody is
   * watching. Output only feeds the tail the next check-in carries; it never postpones one.
   */
  const fireCheckIn = (): void => {
    checkIn = undefined
    if (status !== EShellStatus.Running) return

    try {
      spec.onStillRunning(self)
    } catch {
      // The cadence matters more than any one delivery, so a throwing listener costs one check-in.
    }

    if (status === EShellStatus.Running) {
      checkIn = setTimeout(fireCheckIn, spec.checkInMs ?? 0)
      checkIn.unref?.()
    }
  }

  if (spec.checkInMs !== undefined) {
    checkIn = setTimeout(fireCheckIn, spec.checkInMs)
    checkIn.unref?.()
  }

  const deliverMatches = (): void => {
    matchWatch = undefined
    if (matcher === undefined || !matcher.pending()) return

    const matched = matcher.take()
    try {
      spec.onMatched({ shell: self, matched })
    } catch {
      return
    }
  }

  /**
   * The window opens on the first match and is not reset by the ones behind it, so a shell that
   * matches every line it prints still reports on a cadence rather than never.
   */
  const watchForMatches = (chunk: string): void => {
    if (matcher === undefined) return

    matcher.append(chunk)
    if (!matcher.pending() || matchWatch !== undefined) return

    matchWatch = setTimeout(deliverMatches, spec.matchSettleMs)
    matchWatch.unref?.()
  }

  const overflow = (): void => {
    if (status !== EShellStatus.Running) return
    status = EShellStatus.Overflowed
    forgetPromptWatch()
    forgetCheckIn()
    terminate()
    stopReading(drains)
  }

  const append = (chunk: string): void => {
    if (chunk === '') return
    buffer.append(chunk)
    spec.onActivity?.()
    lastOutputAt = spec.clock.now()
    awaitingSettled = false
    watchForMatches(chunk)
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
      forgetDeadline()
      forgetCheckIn()
      awaitingSettled = false
      if (status === EShellStatus.Running) status = EShellStatus.Exited
      forgetMatchWatch()
      deliverMatches()
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
      exposure: spec.exposure,
    }),

    since: (offset) => buffer.since(offset),
    tail: (limit) => buffer.tail(limit),
    kill,
    release: () => buffer.release(),

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
