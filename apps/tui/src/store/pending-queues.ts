import type { ThreadId } from '@dltech/atlas-core'

import { createPendingQueue, type PendingQueue } from './pending-queue'

export type PendingQueues<Command = never> = {
  forThread(args: { threadId: ThreadId }): PendingQueue<Command>
  waitingCount(): number
}

/**
 * A message typed ahead belongs to the thread it was typed in, so each thread keeps its own
 * queue: swapping conversations never discards one, and the loop drains only the queue of the
 * thread its turn is running on.
 */
export function createPendingQueues<Command = never>(): PendingQueues<Command> {
  const queues = new Map<ThreadId, PendingQueue<Command>>()

  return {
    forThread({ threadId }) {
      const held = queues.get(threadId)
      if (held !== undefined) return held

      const created = createPendingQueue<Command>()
      queues.set(threadId, created)
      return created
    },

    waitingCount() {
      let count = 0
      for (const queue of queues.values()) {
        count += queue.getSnapshot().filter((entry) => entry.kind === 'message').length
      }
      return count
    },
  }
}
