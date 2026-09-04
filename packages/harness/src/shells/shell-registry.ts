import {
  adjustPerfGauge,
  ClockPort,
  EKilledBy,
  EPerfGauge,
  type EventDraft,
  type ThreadId,
} from '@dltech/atlas-core'

import {  portToken } from '../container/injection'
import { HookChainSourceToken, WorkspaceRoot } from '../container/tokens'
import type { HookChainSource } from '../hooks/registry'
import { afterShellDrafts } from './after-shell'
import { startBackgroundShell, type BackgroundShell, type ShellSnapshot } from './background-shell'
import {
  ENotice,
  ShellNoticeQueue,
  take,
  type PendingShellNotice,
  type ShellDelta,
  type Tracked,
} from './notice-queue'
import { toShellId, type ShellId } from './shell-id'
import { compileWatch, MATCH_SETTLE_MS, MATCHED_LINES_CAP, type MatchedLines } from './shell-watch'

export const RETAINED_CHARACTERS = 400_000
export const OVERFLOW_CHARACTERS = 50_000_000
export const PROMPT_SETTLE_MS = 2_000
export const CHECK_IN_EVERY_MS = 300_000
export const CHECK_IN_TAIL_CHARACTERS = 1_000

export type StartedShellOutcome = { ok: true; snapshot: ShellSnapshot } | { ok: false; reason: string }

export type ShellReadOutcome =
  | { ok: true; snapshot: ShellSnapshot; delta: ShellDelta }
  | { ok: false; reason: string }

export type ShellKillOutcome = { ok: true; snapshot: ShellSnapshot } | { ok: false; reason: string }

/**
 * A shell belongs to the thread that started it. Every read is scoped to an owner so a conversation
 * is never told about, nor able to kill, a shell another conversation is running; only the exit
 * guard and teardown look across all of them, because a process dying kills them all regardless.
 */
export abstract class ShellRegistryPort {
  abstract start(args: {
    threadId: ThreadId
    command: string
    description: string
    cwd?: string | undefined
    watch?: string | undefined
    timeoutMs?: number | undefined
    checkInMs?: number | undefined
  }): StartedShellOutcome
  abstract read(args: { shellId: string; threadId: ThreadId }): ShellReadOutcome
  abstract peek(args: {
    shellId: string
    characters: number
    threadId: ThreadId
  }): string | undefined
  abstract kill(args: { shellId: string; by: EKilledBy; threadId: ThreadId }): ShellKillOutcome
  abstract list(args: { threadId: ThreadId }): readonly ShellSnapshot[]
  abstract listEverywhere(): readonly ShellSnapshot[]
  abstract drainNotifications(args: { threadId: ThreadId }): readonly EventDraft[]
  abstract pendingNotices(args: { threadId: ThreadId }): readonly PendingShellNotice[]
  abstract threadsAwaitingNotice(): readonly ThreadId[]
  abstract onNotice(listener: () => void): () => void
  abstract forgetNotices(args: { threadId: ThreadId }): void
  abstract closeAll(): Promise<void>
}

const unknownShell = (args: { shellId: string; known: readonly ShellId[] }): string => {
  const known = args.known.length === 0 ? 'none is running' : args.known.join(', ')
  return `no background shell is registered as "${args.shellId}"; known shells: ${known}`
}

export class BunShellRegistry extends ShellRegistryPort {
  private readonly tracked = new Map<ShellId, Tracked>()
  private readonly notices = new ShellNoticeQueue(({ shellId }) =>
    this.tracked.get(toShellId(shellId))?.shell.snapshot(),
  )
  private readonly settling = new Set<Promise<void>>()
  private started = 0

  constructor(
     private readonly root: string,
     private readonly clock: ClockPort,
     private readonly hooks: HookChainSource,
  ) {
    super()
  }

  start(args: {
    threadId: ThreadId
    command: string
    description: string
    cwd?: string | undefined
    watch?: string | undefined
    timeoutMs?: number | undefined
    checkInMs?: number | undefined
  }): StartedShellOutcome {
    const watch = compileWatch(args.watch)
    if (!watch.ok) return watch

    this.started += 1
    const shellId = toShellId(`bash_${this.started}`)
    const checkInMs = args.checkInMs ?? CHECK_IN_EVERY_MS

    const opened = startBackgroundShell({
      shellId,
      command: args.command,
      description: args.description,
      cwd: args.cwd ?? this.root,
      clock: this.clock,
      retainCharacters: RETAINED_CHARACTERS,
      overflowCharacters: OVERFLOW_CHARACTERS,
      promptSettleMs: PROMPT_SETTLE_MS,
      watch: watch.pattern,
      matchSettleMs: MATCH_SETTLE_MS,
      matchedLinesCap: MATCHED_LINES_CAP,
      timeoutMs: args.timeoutMs,
      checkInMs,
      onExit: (shell) => this.announceExit(shell),
      onAwaitingInput: (shell) => this.announceAwaitingInput(shell),
      onMatched: (matched) => this.announceMatched(matched),
      onStillRunning: (shell) => this.announceStillRunning({ shell, checkInMs }),
    })
    if (!opened.ok) return opened

    this.tracked.set(shellId, {
      shell: opened.shell,
      cursor: 0,
      announced: false,
      threadId: args.threadId,
      pattern: args.watch,
    })
    adjustPerfGauge({ key: EPerfGauge.ActiveShells, delta: 1 })

    return { ok: true, snapshot: opened.shell.snapshot() }
  }

  read({ shellId, threadId }: { shellId: string; threadId: ThreadId }): ShellReadOutcome {
    const entry = this.entryFor({ shellId, threadId })
    if (entry === undefined) {
      return { ok: false, reason: unknownShell({ shellId, known: this.ids(threadId) }) }
    }

    return { ok: true, snapshot: entry.shell.snapshot(), delta: take(entry) }
  }

  /**
   * The cursor belongs to the model's reading of a shell, so a human looking at the same shell in
   * the sidebar must not advance it.
   */
  peek({
    shellId,
    characters,
    threadId,
  }: {
    shellId: string
    characters: number
    threadId: ThreadId
  }): string | undefined {
    return this.entryFor({ shellId, threadId })?.shell.tail(characters)
  }

  kill({
    shellId,
    by,
    threadId,
  }: {
    shellId: string
    by: EKilledBy
    threadId: ThreadId
  }): ShellKillOutcome {
    const entry = this.entryFor({ shellId, threadId })
    if (entry === undefined) {
      return { ok: false, reason: unknownShell({ shellId, known: this.ids(threadId) }) }
    }

    entry.shell.kill(by)
    return { ok: true, snapshot: entry.shell.snapshot() }
  }

  list({ threadId }: { threadId: ThreadId }): readonly ShellSnapshot[] {
    return [...this.tracked.values()]
      .filter((entry) => entry.threadId === threadId)
      .map((entry) => entry.shell.snapshot())
  }

  listEverywhere(): readonly ShellSnapshot[] {
    return [...this.tracked.values()].map((entry) => entry.shell.snapshot())
  }

  drainNotifications({ threadId }: { threadId: ThreadId }): readonly EventDraft[] {
    return this.notices.drain({ threadId })
  }

  pendingNotices({ threadId }: { threadId: ThreadId }): readonly PendingShellNotice[] {
    return this.notices.pending({ threadId })
  }

  threadsAwaitingNotice(): readonly ThreadId[] {
    return this.notices.threadsAwaiting()
  }

  onNotice(listener: () => void): () => void {
    return this.notices.onNotice(listener)
  }

  forgetNotices({ threadId }: { threadId: ThreadId }): void {
    this.notices.forget({ threadId })
  }

  /**
   * Reaping is by spawner rather than by process tree: a shell the model backgrounded outlives the
   * turn by design, so only the session that started it knows when nobody is left to read it.
   * Teardown kills, but it does not suppress: every ending announces itself, including this one.
   */
  async closeAll(): Promise<void> {
    const running = [...this.tracked.values()]
    for (const entry of running) entry.shell.kill(EKilledBy.SessionEnd)
    await Promise.all(running.map((entry) => entry.shell.exited))
    while (this.settling.size > 0) await Promise.all([...this.settling])
    this.tracked.clear()
  }

  private ids(threadId: ThreadId): readonly ShellId[] {
    return [...this.tracked.entries()]
      .filter(([, entry]) => entry.threadId === threadId)
      .map(([id]) => id)
  }

  private entryFor({
    shellId,
    threadId,
  }: {
    shellId: string
    threadId: ThreadId
  }): Tracked | undefined {
    for (const [id, entry] of this.tracked) {
      if (id === shellId && entry.threadId === threadId) return entry
    }
    return undefined
  }

  /**
   * The after-shell hooks run before the ending is queued rather than beside it: with no turn in
   * flight their drafts have nowhere else to go, and riding with the notice is the only delivery
   * this registry can promise. A shell that has already announced never runs them twice.
   */
  private announceExit(shell: BackgroundShell): void {
    const entry = this.tracked.get(shell.shellId)
    if (entry === undefined || entry.announced) return

    entry.announced = true
    adjustPerfGauge({ key: EPerfGauge.ActiveShells, delta: -1 })

    const settling = this.queueEnding({ entry, shell })
    this.settling.add(settling)
    void settling.finally(() => void this.settling.delete(settling))
  }

  private async queueEnding(args: {
    entry: Tracked
    shell: BackgroundShell
  }): Promise<void> {
    const hooked = await afterShellDrafts({
      hooks: this.hooks,
      threadId: args.entry.threadId,
      shell: args.shell.snapshot(),
    })

    this.queue({ kind: ENotice.Ended, entry: args.entry, shell: args.shell, hooked })
  }

  private announceAwaitingInput(shell: BackgroundShell): void {
    const entry = this.tracked.get(shell.shellId)
    if (entry === undefined || entry.announced) return

    this.queue({ kind: ENotice.AwaitingInput, entry, shell })
  }

  private announceStillRunning(args: { shell: BackgroundShell; checkInMs: number }): void {
    const entry = this.tracked.get(args.shell.shellId)
    if (entry === undefined || entry.announced) return

    const snapshot = args.shell.snapshot()
    const now = Date.parse(this.clock.now())

    this.notices.queue({
      kind: ENotice.StillRunning,
      snapshot,
      threadId: entry.threadId,
      peek: () => args.shell.tail(CHECK_IN_TAIL_CHARACTERS),
      runningForMs: Math.max(now - Date.parse(snapshot.startedAt), 0),
      silentForMs: Math.max(now - Date.parse(snapshot.lastOutputAt), 0),
      checkInMs: args.checkInMs,
    })
  }

  /**
   * A match is queued with the lines already in hand rather than a cursor read, so what the model
   * is shown as matching is never subtracted from what shell_output would hand it next.
   */
  private announceMatched({
    shell,
    matched,
  }: {
    shell: BackgroundShell
    matched: MatchedLines
  }): void {
    const entry = this.tracked.get(shell.shellId)
    if (entry === undefined || entry.pattern === undefined) return

    this.notices.queue({
      kind: ENotice.Matched,
      snapshot: shell.snapshot(),
      threadId: entry.threadId,
      pattern: entry.pattern,
      matched,
    })
  }

  private queue(args: {
    kind: ENotice.Ended | ENotice.AwaitingInput
    entry: Tracked
    shell: BackgroundShell
    hooked?: readonly EventDraft[] | undefined
  }): void {
    this.notices.queue({
      kind: args.kind,
      snapshot: args.shell.snapshot(),
      take: () => take(args.entry),
      threadId: args.entry.threadId,
      hooked: args.hooked,
    })
  }
}
