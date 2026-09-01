import { ClockPort, EKilledBy, EShellStatus, type EventDraft, type ThreadId } from '@dltech/atlas-core'

import { inject, injectable, portToken } from '../container/injection'
import { WorkspaceRoot } from '../container/tokens'
import { startBackgroundShell, type BackgroundShell, type ShellSnapshot } from './background-shell'
import { awaitingInputDraft, endedDraft } from './notifications'
import { toShellId, type ShellId } from './shell-id'

export const RETAINED_CHARACTERS = 400_000
export const OVERFLOW_CHARACTERS = 50_000_000
export const DELIVERED_CHARACTERS = 30_000
export const PROMPT_SETTLE_MS = 2_000

export enum ENotice {
  Ended = 'ended',
  AwaitingInput = 'awaiting-input',
}

export type ShellDelta = {
  text: string
  droppedCharacters: number
  remainingCharacters: number
}

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
  abstract pendingNotices(args: { threadId: ThreadId }): readonly ShellSnapshot[]
  abstract threadsAwaitingNotice(): readonly ThreadId[]
  abstract onNotice(listener: () => void): () => void
  abstract forgetNotices(args: { threadId: ThreadId }): void
  abstract closeAll(): Promise<void>
}

type Tracked = { shell: BackgroundShell; cursor: number; announced: boolean; threadId: ThreadId }

/**
 * The delta is read when the notice is handed over rather than when the shell exits, so a notice
 * that is dropped rather than delivered leaves its output where shell_output can still find it.
 */
type Notice = {
  kind: ENotice
  snapshot: ShellSnapshot
  take: () => ShellDelta
  threadId: ThreadId
}

const NOTHING_PENDING: readonly Notice[] = Object.freeze([])

const NOTHING_ANNOUNCED: readonly ShellSnapshot[] = Object.freeze([])

const NOTHING_DRAINED: readonly EventDraft[] = Object.freeze([])

const NOTHING_NOTICED: ReadonlyMap<ThreadId, readonly ShellSnapshot[]> = new Map()

/**
 * The cursor is the model's place in a shell, so taking a delta is what marks output as delivered.
 */
function take(entry: Tracked): ShellDelta {
  const delta = entry.shell.since(entry.cursor)
  const text = delta.text.slice(0, DELIVERED_CHARACTERS)
  entry.cursor = entry.cursor + delta.droppedCharacters + text.length

  return {
    text,
    droppedCharacters: delta.droppedCharacters,
    remainingCharacters: Math.max(delta.totalCharacters - entry.cursor, 0),
  }
}

const unknownShell = (args: { shellId: string; known: readonly ShellId[] }): string => {
  const known = args.known.length === 0 ? 'none is running' : args.known.join(', ')
  return `no background shell is registered as "${args.shellId}"; known shells: ${known}`
}

@injectable()
export class BunShellRegistry extends ShellRegistryPort {
  private readonly tracked = new Map<ShellId, Tracked>()
  private queued: readonly Notice[] = NOTHING_PENDING
  private noticed: ReadonlyMap<ThreadId, readonly ShellSnapshot[]> = NOTHING_NOTICED
  private readonly listeners = new Set<() => void>()
  private started = 0

  constructor(
    @inject(WorkspaceRoot) private readonly root: string,
    @inject(portToken(ClockPort)) private readonly clock: ClockPort,
  ) {
    super()
  }

  start(args: {
    threadId: ThreadId
    command: string
    description: string
    cwd?: string | undefined
  }): StartedShellOutcome {
    this.started += 1
    const shellId = toShellId(`bash_${this.started}`)

    const opened = startBackgroundShell({
      shellId,
      command: args.command,
      description: args.description,
      cwd: args.cwd ?? this.root,
      clock: this.clock,
      retainCharacters: RETAINED_CHARACTERS,
      overflowCharacters: OVERFLOW_CHARACTERS,
      promptSettleMs: PROMPT_SETTLE_MS,
      onExit: (shell) => this.announceExit(shell),
      onAwaitingInput: (shell) => this.announceAwaitingInput(shell),
    })
    if (!opened.ok) return opened

    this.tracked.set(shellId, {
      shell: opened.shell,
      cursor: 0,
      announced: false,
      threadId: args.threadId,
    })

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

  /**
   * An awaiting-input notice is dropped if the shell ended before it was handed over: the prompt
   * stopped being the reason nothing is coming, and the ending queued behind it carries the output.
   */
  drainNotifications({ threadId }: { threadId: ThreadId }): readonly EventDraft[] {
    const handed = this.queued.filter((notice) => notice.threadId === threadId)
    if (handed.length === 0) return NOTHING_DRAINED

    this.settleNotices(this.queued.filter((notice) => notice.threadId !== threadId))

    return handed.filter((notice) => this.stillWorthTelling(notice)).map((notice) => this.draftOf(notice))
  }

  private stillWorthTelling(notice: Notice): boolean {
    if (notice.kind === ENotice.Ended) return true

    const live = this.tracked.get(notice.snapshot.shellId)?.shell.snapshot()
    return live === undefined || live.status === EShellStatus.Running
  }

  private draftOf(notice: Notice): EventDraft {
    const delta = notice.take()
    return notice.kind === ENotice.Ended
      ? endedDraft({ snapshot: notice.snapshot, delta })
      : awaitingInputDraft({ snapshot: notice.snapshot, delta })
  }

  pendingNotices({ threadId }: { threadId: ThreadId }): readonly ShellSnapshot[] {
    return this.noticed.get(threadId) ?? NOTHING_ANNOUNCED
  }

  threadsAwaitingNotice(): readonly ThreadId[] {
    return [...this.noticed.keys()]
  }

  onNotice(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  forgetNotices({ threadId }: { threadId: ThreadId }): void {
    const kept = this.queued.filter((notice) => notice.threadId !== threadId)
    if (kept.length === this.queued.length) return

    this.settleNotices(kept)
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

  private announceExit(shell: BackgroundShell): void {
    const entry = this.tracked.get(shell.shellId)
    if (entry === undefined || entry.announced) return

    entry.announced = true
    this.queue({ kind: ENotice.Ended, entry, shell })
  }

  private announceAwaitingInput(shell: BackgroundShell): void {
    const entry = this.tracked.get(shell.shellId)
    if (entry === undefined || entry.announced) return

    this.queue({ kind: ENotice.AwaitingInput, entry, shell })
  }

  private queue(args: { kind: ENotice; entry: Tracked; shell: BackgroundShell }): void {
    this.settleNotices([
      ...this.queued,
      {
        kind: args.kind,
        snapshot: args.shell.snapshot(),
        take: () => take(args.entry),
        threadId: args.entry.threadId,
      },
    ])
  }

  /**
   * The snapshots are held rather than derived per call: pendingNotices backs a React external
   * store, which reads it on every render and requires a stable value between changes.
   */
  private settleNotices(notices: readonly Notice[]): void {
    this.queued = notices

    const byThread = new Map<ThreadId, ShellSnapshot[]>()
    for (const notice of notices) {
      const held = byThread.get(notice.threadId)
      if (held === undefined) byThread.set(notice.threadId, [notice.snapshot])
      else held.push(notice.snapshot)
    }
    this.noticed = byThread

    for (const listener of [...this.listeners]) listener()
  }
}
