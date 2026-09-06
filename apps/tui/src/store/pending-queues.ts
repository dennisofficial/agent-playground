import type { ThreadId } from '@dltech/atlas-core'

import { createPendingQueue, type PendingQueue } from './pending-queue'

export type PendingQueues = {
  forThread(args: { threadId: ThreadId }): PendingQueue
  waitingCount(): number
}

/**
 * A message typed ahead belongs to the thread it was typed in, so each thread keeps its own
 * queue: swapping conversations never discards one, and the loop drains only the queue of the
 * thread its turn is running on.
 */
export function createPendingQueues(): PendingQueues {
  const queues = new Map<ThreadId, PendingQueue>()

  return {
    forThread({ threadId }) {
      const held = queues.get(threadId)
      if (held !== undefined) return held

      const created = createPendingQueue()
      queues.set(threadId, created)
      return created
    },

    waitingCount() {
      let count = 0
      for (const queue of queues.values()) {
        count += queue.getSnapshot().filter((message) => !message.taken).length
      }
      return count
    },
  }
}
