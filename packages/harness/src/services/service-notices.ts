import type { EventDraft, ThreadId } from '@dltech/atlas-core'

import { logTail, type ServiceSnapshot } from './service-process'

export const ENDING_TAIL_CHARACTERS = 4_000

export type ServiceNotice = { snapshot: ServiceSnapshot; threadId: ThreadId }

/**
 * The tail is read at handover rather than at exit: a notice that is dropped rather than delivered
 * takes nothing with it, because the log file keeps everything the service ever printed.
 */
export function serviceEndedDraft(args: { snapshot: ServiceSnapshot }): EventDraft {
  const { snapshot } = args

  return {
    type: 'service-ended',
    serviceId: snapshot.serviceId,
    command: snapshot.command,
    description: snapshot.description,
    status: snapshot.status,
    killedBy: snapshot.killedBy,
    exitCode: snapshot.exitCode,
    logPath: snapshot.logPath,
    tail: logTail({ path: snapshot.logPath, characters: ENDING_TAIL_CHARACTERS }),
  }
}

const NOTHING_PENDING: readonly ServiceNotice[] = Object.freeze([])

const NOTHING_ANNOUNCED: readonly ServiceSnapshot[] = Object.freeze([])

const NOTHING_DRAINED: readonly EventDraft[] = Object.freeze([])

const NOTHING_NOTICED: ReadonlyMap<ThreadId, readonly ServiceSnapshot[]> = new Map()

export class ServiceNoticeQueue {
  private queued: readonly ServiceNotice[] = NOTHING_PENDING
  private noticed: ReadonlyMap<ThreadId, readonly ServiceSnapshot[]> = NOTHING_NOTICED
  private readonly listeners = new Set<() => void>()

  queue(notice: ServiceNotice): void {
    this.settle([...this.queued, notice])
  }

  drain({ threadId }: { threadId: ThreadId }): readonly EventDraft[] {
    const handed = this.queued.filter((notice) => notice.threadId === threadId)
    if (handed.length === 0) return NOTHING_DRAINED

    this.settle(this.queued.filter((notice) => notice.threadId !== threadId))

    return handed.map((notice) => serviceEndedDraft({ snapshot: notice.snapshot }))
  }

  pending({ threadId }: { threadId: ThreadId }): readonly ServiceSnapshot[] {
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
   * The snapshots are held rather than derived per call: pending backs a React external store,
   * which reads it on every render and requires a stable value between changes.
   */
  private settle(notices: readonly ServiceNotice[]): void {
    this.queued = notices

    const byThread = new Map<ThreadId, ServiceSnapshot[]>()
    for (const notice of notices) {
      const held = byThread.get(notice.threadId)
      if (held === undefined) byThread.set(notice.threadId, [notice.snapshot])
      else held.push(notice.snapshot)
    }
    this.noticed = byThread

    for (const listener of [...this.listeners]) listener()
  }
}
