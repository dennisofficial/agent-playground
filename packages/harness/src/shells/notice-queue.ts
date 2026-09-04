import { EShellStatus, type EventDraft, type ThreadId } from '@dltech/atlas-core'

import type { BackgroundShell, ShellSnapshot } from './background-shell'
import { awaitingInputDraft, endedDraft, matchedDraft, stillRunningDraft } from './notifications'
import type { MatchedLines } from './shell-watch'

export const DELIVERED_CHARACTERS = 30_000

export type Tracked = {
  shell: BackgroundShell
  cursor: number
  announced: boolean
  threadId: ThreadId
  pattern?: string | undefined
}

export enum ENotice {
  Ended = 'ended',
  AwaitingInput = 'awaiting-input',
  Matched = 'matched',
  StillRunning = 'still-running',
}

export type ShellDelta = {
  text: string
  droppedCharacters: number
  remainingCharacters: number
}

type NoticedShell = { snapshot: ShellSnapshot; threadId: ThreadId }

/**
 * The delta is read when the notice is handed over rather than when the shell exits, so a notice
 * that is dropped rather than delivered leaves its output where shell_output can still find it.
 *
 * `hooked` is what the after-shell hooks produced for this ending. It travels with the notice
 * because nothing else can deliver it: the shell may well have ended with no turn in flight.
 *
 * A match carries its lines instead of a delta: the matcher accumulates separately from the
 * delivery cursor, so nothing about a match is read out of the shell's undelivered output.
 */
export type ShellNotice =
  | (NoticedShell & {
      kind: ENotice.Ended
      take: () => ShellDelta
      hooked?: readonly EventDraft[] | undefined
    })
  | (NoticedShell & { kind: ENotice.AwaitingInput; take: () => ShellDelta })
  | (NoticedShell & { kind: ENotice.Matched; pattern: string; matched: MatchedLines })
  | (NoticedShell & {
      kind: ENotice.StillRunning
      peek: () => string
      runningForMs: number
      silentForMs: number
      checkInMs: number
    })

/**
 * A pending row must know which kind of notice it is: a still-running shell announced as
 * "waiting on input" would send the operator to answer a prompt that does not exist.
 */
export type PendingShellNotice = { kind: ENotice; snapshot: ShellSnapshot }

/**
 * The cursor is the model's place in a shell, so taking a delta is what marks output as delivered.
 */
export function take(entry: Tracked): ShellDelta {
  const delta = entry.shell.since(entry.cursor)
  const text = delta.text.slice(0, DELIVERED_CHARACTERS)
  entry.cursor = entry.cursor + delta.droppedCharacters + text.length
  const remainingCharacters = Math.max(delta.totalCharacters - entry.cursor, 0)

  if (remainingCharacters === 0 && entry.shell.snapshot().status !== EShellStatus.Running) {
    entry.shell.release()
  }

  return { text, droppedCharacters: delta.droppedCharacters, remainingCharacters }
}

const NOTHING_PENDING: readonly ShellNotice[] = Object.freeze([])

const NOTHING_ANNOUNCED: readonly PendingShellNotice[] = Object.freeze([])

export const NOTHING_DRAINED: readonly EventDraft[] = Object.freeze([])

const NOTHING_NOTICED: ReadonlyMap<ThreadId, readonly PendingShellNotice[]> = new Map()

export class ShellNoticeQueue {
  private queued: readonly ShellNotice[] = NOTHING_PENDING
  private noticed: ReadonlyMap<ThreadId, readonly PendingShellNotice[]> = NOTHING_NOTICED
  private readonly listeners = new Set<() => void>()

  constructor(private readonly live: (args: { shellId: string }) => ShellSnapshot | undefined) {}

  /**
   * Check-ins arrive on a cadence whether or not the last one was drained, so an undrained one is
   * replaced by its fresher successor rather than stacked behind it.
   */
  queue(notice: ShellNotice): void {
    const kept =
      notice.kind === ENotice.StillRunning
        ? this.queued.filter(
            (held) =>
              held.kind !== ENotice.StillRunning ||
              held.snapshot.shellId !== notice.snapshot.shellId,
          )
        : this.queued
    this.settle([...kept, notice])
  }

  /**
   * An awaiting-input notice is dropped if the shell ended before it was handed over: the prompt
   * stopped being the reason nothing is coming, and the ending queued behind it carries the output.
   */
  drain({ threadId }: { threadId: ThreadId }): readonly EventDraft[] {
    const handed = this.queued.filter((notice) => notice.threadId === threadId)
    if (handed.length === 0) return NOTHING_DRAINED

    this.settle(this.queued.filter((notice) => notice.threadId !== threadId))

    return handed
      .filter((notice) => this.stillWorthTelling(notice))
      .flatMap((notice) => this.draftsOf(notice))
  }

  pending({ threadId }: { threadId: ThreadId }): readonly PendingShellNotice[] {
    return this.noticed.get(threadId) ?? NOTHING_ANNOUNCED
  }

  threadsAwaiting(): readonly ThreadId[] {
    return [...this.noticed.keys()]
  }

  onNotice(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  forget({ threadId }: { threadId: ThreadId }): void {
    const kept = this.queued.filter((notice) => notice.threadId !== threadId)
    if (kept.length === this.queued.length) return

    this.settle(kept)
  }

  /**
   * A check-in queued behind an ending is dead on arrival: the shell it describes as running is
   * not, and the ending queued beside it already says so.
   */
  private stillWorthTelling(notice: ShellNotice): boolean {
    if (notice.kind === ENotice.StillRunning) {
      const live = this.live({ shellId: notice.snapshot.shellId })
      return live !== undefined && live.status === EShellStatus.Running
    }
    if (notice.kind !== ENotice.AwaitingInput) return true

    const live = this.live({ shellId: notice.snapshot.shellId })
    return live === undefined || live.status === EShellStatus.Running
  }

  private draftsOf(notice: ShellNotice): readonly EventDraft[] {
    if (notice.kind === ENotice.Matched) {
      return [
        matchedDraft({
          snapshot: notice.snapshot,
          pattern: notice.pattern,
          matched: notice.matched,
        }),
      ]
    }

    if (notice.kind === ENotice.StillRunning) {
      return [
        stillRunningDraft({
          snapshot: notice.snapshot,
          tail: notice.peek(),
          runningForMs: notice.runningForMs,
          silentForMs: notice.silentForMs,
          checkInMs: notice.checkInMs,
        }),
      ]
    }

    const delta = notice.take()
    if (notice.kind === ENotice.AwaitingInput) {
      return [awaitingInputDraft({ snapshot: notice.snapshot, delta })]
    }

    return [endedDraft({ snapshot: notice.snapshot, delta }), ...(notice.hooked ?? [])]
  }

  /**
   * The snapshots are held rather than derived per call: pending backs a React external store,
   * which reads it on every render and requires a stable value between changes.
   */
  private settle(notices: readonly ShellNotice[]): void {
    this.queued = notices

    const byThread = new Map<ThreadId, PendingShellNotice[]>()
    for (const notice of notices) {
      const held = byThread.get(notice.threadId)
      const pending: PendingShellNotice = { kind: notice.kind, snapshot: notice.snapshot }
      if (held === undefined) byThread.set(notice.threadId, [pending])
      else held.push(pending)
    }
    this.noticed = byThread

    for (const listener of [...this.listeners]) listener()
  }
}
