import type { EventDraft, ThreadId } from '@dltech/atlas-core'

import type { AgentSnapshot } from './snapshot'

export type AgentNotice = { threadId: ThreadId; snapshot: AgentSnapshot; draft: EventDraft }

const NOTHING_PENDING: readonly AgentNotice[] = Object.freeze([])

const NOTHING_ANNOUNCED: readonly AgentSnapshot[] = Object.freeze([])

const NOTHING_DRAINED: readonly EventDraft[] = Object.freeze([])

const NOTHING_NOTICED: ReadonlyMap<ThreadId, readonly AgentSnapshot[]> = new Map()

export class AgentNoticeQueue {
  private queued: readonly AgentNotice[] = NOTHING_PENDING
  private noticed: ReadonlyMap<ThreadId, readonly AgentSnapshot[]> = NOTHING_NOTICED
  private readonly listeners = new Set<() => void>()

  queue(notice: AgentNotice): void {
    this.settle([...this.queued, notice])
  }

  drain({ threadId }: { threadId: ThreadId }): readonly EventDraft[] {
    const handed = this.queued.filter((notice) => notice.threadId === threadId)
    if (handed.length === 0) return NOTHING_DRAINED

    this.settle(this.queued.filter((notice) => notice.threadId !== threadId))

    return handed.map((notice) => notice.draft)
  }

  pending({ threadId }: { threadId: ThreadId }): readonly AgentSnapshot[] {
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

  forgetAgents({ threadId, agentIds }: { threadId: ThreadId; agentIds: readonly ThreadId[] }): void {
    const removed = new Set(agentIds)
    const kept = this.queued.filter(
      (notice) => notice.threadId !== threadId || !removed.has(notice.snapshot.agentId),
    )
    if (kept.length === this.queued.length) return

    this.settle(kept)
  }

  /**
   * The snapshots are held rather than derived per call: pending backs a React external store,
   * which reads it on every render and requires a stable value between changes.
   */
  private settle(notices: readonly AgentNotice[]): void {
    this.queued = notices

    const byThread = new Map<ThreadId, AgentSnapshot[]>()
    for (const notice of notices) {
      const held = byThread.get(notice.threadId)
      if (held === undefined) byThread.set(notice.threadId, [notice.snapshot])
      else held.push(notice.snapshot)
    }
    this.noticed = byThread

    for (const listener of [...this.listeners]) listener()
  }
}
