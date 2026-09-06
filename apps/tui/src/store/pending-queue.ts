import type { Event, SaidImage } from '@dltech/atlas-core'

export type PendingSaid = { text: string; images: readonly SaidImage[] }

export type PendingMessage = PendingSaid & { id: string; taken: boolean }

export type PendingQueue = {
  subscribe(listener: () => void): () => void
  getSnapshot(): readonly PendingMessage[]
  enqueue(args: { text: string; images?: readonly SaidImage[] }): void
  takeBackLast(): PendingMessage | null
  drain(): readonly PendingSaid[]
  settleTaken(args: { events: readonly Event[] }): void
}

const NOTHING_PENDING: readonly PendingMessage[] = Object.freeze([])

const NOTHING_TAKEN: readonly PendingSaid[] = Object.freeze([])

const NO_IMAGES: readonly SaidImage[] = Object.freeze([])

const takenRunAnsweredIn = (args: {
  events: readonly Event[]
  taken: readonly PendingMessage[]
}): boolean => {
  const { events, taken } = args

  for (let start = events.length - taken.length; start >= 0; start -= 1) {
    const matches = taken.every((message, offset) => {
      const event = events[start + offset]
      return event?.type === 'user-said' && event.text === message.text
    })
    if (matches) return start + taken.length < events.length
  }

  return false
}

export function createPendingQueue(): PendingQueue {
  let taken: readonly PendingMessage[] = NOTHING_PENDING
  let waiting: readonly PendingMessage[] = NOTHING_PENDING
  let snapshot: readonly PendingMessage[] = NOTHING_PENDING
  let stamped = 0

  const listeners = new Set<() => void>()

  const settle = (next: { taken?: readonly PendingMessage[]; waiting?: readonly PendingMessage[] }) => {
    taken = next.taken ?? taken
    waiting = next.waiting ?? waiting
    snapshot = taken.length === 0 ? waiting : [...taken, ...waiting]
    for (const listener of [...listeners]) listener()
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },

    getSnapshot: () => snapshot,

    enqueue({ text, images }) {
      stamped += 1
      settle({
        waiting: [
          ...waiting,
          { id: `pending-${stamped}`, text, images: images ?? NO_IMAGES, taken: false },
        ],
      })
    },

    takeBackLast() {
      const last = waiting.at(-1)
      if (last !== undefined) {
        settle({ waiting: waiting.slice(0, -1) })
        return last
      }

      const recalled = taken.at(-1)
      if (recalled === undefined) return null

      settle({ taken: taken.slice(0, -1) })
      return recalled
    },

    drain() {
      if (waiting.length === 0) return NOTHING_TAKEN

      const handed = waiting.map((message) => ({ ...message, taken: true }))
      settle({ taken: [...taken, ...handed], waiting: NOTHING_PENDING })
      return handed.map((message) => ({ text: message.text, images: message.images }))
    },

    settleTaken({ events }) {
      if (taken.length === 0) return
      if (!takenRunAnsweredIn({ events, taken })) return

      settle({ taken: NOTHING_PENDING })
    },
  }
}
