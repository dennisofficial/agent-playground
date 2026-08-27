export type PendingMessage = { id: string; text: string }

export type PendingQueue = {
  subscribe(listener: () => void): () => void
  getSnapshot(): readonly PendingMessage[]
  enqueue(args: { text: string }): void
  takeBackLast(): PendingMessage | null
  drain(): readonly string[]
  clear(): void
}

const NOTHING_PENDING: readonly PendingMessage[] = Object.freeze([])

const NOTHING_TAKEN: readonly string[] = Object.freeze([])

export function createPendingQueue(): PendingQueue {
  let waiting: readonly PendingMessage[] = NOTHING_PENDING
  let stamped = 0

  const listeners = new Set<() => void>()

  const settle = (next: readonly PendingMessage[]) => {
    waiting = next
    for (const listener of [...listeners]) listener()
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },

    getSnapshot: () => waiting,

    enqueue({ text }) {
      stamped += 1
      settle([...waiting, { id: `pending-${stamped}`, text }])
    },

    takeBackLast() {
      const last = waiting.at(-1)
      if (last === undefined) return null

      settle(waiting.slice(0, -1))
      return last
    },

    drain() {
      if (waiting.length === 0) return NOTHING_TAKEN

      const taken = waiting.map((message) => message.text)
      settle(NOTHING_PENDING)
      return taken
    },

    clear() {
      if (waiting.length === 0) return
      settle(NOTHING_PENDING)
    },
  }
}
