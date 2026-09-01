import type { Event, SaidImage } from '@dltech/atlas-core'

export type PendingSaid = { text: string; images: readonly SaidImage[] }

export type PendingMessage = PendingSaid & { id: string; taken: boolean }

export type PendingQueue = {
  subscribe(listener: () => void): () => void
  getSnapshot(): readonly PendingMessage[]
  enqueue(args: { text: string; images?: readonly SaidImage[] }): void
  takeBackLast(): PendingMessage | null
  drain(): readonly PendingSaid[]
  settleTaken(args: { landed: readonly string[] }): void
  clear(): void
}

const NOTHING_PENDING: readonly PendingMessage[] = Object.freeze([])

const NOTHING_TAKEN: readonly PendingSaid[] = Object.freeze([])

const NO_IMAGES: readonly SaidImage[] = Object.freeze([])

export const trailingSaid = (events: readonly Event[]): readonly string[] => {
  const said: string[] = []

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'user-said') break
    said.unshift(event.text)
  }

  return said
}

const landedInOrder = (args: { landed: readonly string[]; taken: readonly PendingMessage[] }): boolean => {
  const said = args.taken.map((message) => message.text)

  return args.landed.some(
    (_text, start) =>
      start + said.length <= args.landed.length &&
      said.every((text, offset) => text === args.landed[start + offset]),
  )
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
      if (last === undefined) return null

      settle({ waiting: waiting.slice(0, -1) })
      return last
    },

    drain() {
      if (waiting.length === 0) return NOTHING_TAKEN

      const handed = waiting.map((message) => ({ ...message, taken: true }))
      settle({ taken: [...taken, ...handed], waiting: NOTHING_PENDING })
      return handed.map((message) => ({ text: message.text, images: message.images }))
    },

    settleTaken({ landed }) {
      if (taken.length === 0) return
      if (!landedInOrder({ landed, taken })) return

      settle({ taken: NOTHING_PENDING })
    },

    clear() {
      if (snapshot.length === 0) return
      settle({ taken: NOTHING_PENDING, waiting: NOTHING_PENDING })
    },
  }
}
