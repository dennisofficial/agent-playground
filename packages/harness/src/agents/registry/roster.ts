import type { ThreadId } from '@dltech/atlas-core'

import { snapshotOf, type ChildState } from './child-state'
import type { AgentSnapshot } from './snapshot'

const NOTHING_LISTED: readonly AgentSnapshot[] = Object.freeze([])

const NOTHING_OWNED: ReadonlyMap<ThreadId, readonly AgentSnapshot[]> = new Map()

/**
 * The snapshots are held rather than derived per call: the listings back a React external store,
 * which reads them on every render and requires a stable value between changes.
 */
export class AgentRoster {
  private readonly children = new Map<ThreadId, ChildState>()
  private everywhere: readonly AgentSnapshot[] = NOTHING_LISTED
  private owned: ReadonlyMap<ThreadId, readonly AgentSnapshot[]> = NOTHING_OWNED
  private readonly listeners = new Set<() => void>()

  add(child: ChildState): void {
    this.children.set(child.agentId, child)
    this.settle()
  }

  changed(): void {
    this.settle()
  }

  find(agentId: ThreadId): ChildState | undefined {
    return this.children.get(agentId)
  }

  states(): readonly ChildState[] {
    return [...this.children.values()]
  }

  list(threadId: ThreadId): readonly AgentSnapshot[] {
    return this.owned.get(threadId) ?? NOTHING_LISTED
  }

  listEverywhere(): readonly AgentSnapshot[] {
    return this.everywhere
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  private settle(): void {
    const everywhere = this.states().map(snapshotOf)

    const owned = new Map<ThreadId, AgentSnapshot[]>()
    for (const snapshot of everywhere) {
      const held = owned.get(snapshot.spawnedBy)
      if (held === undefined) owned.set(snapshot.spawnedBy, [snapshot])
      else held.push(snapshot)
    }

    this.everywhere = everywhere
    this.owned = owned

    for (const listener of [...this.listeners]) listener()
  }
}
