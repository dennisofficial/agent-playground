import type { Event, SaidImage } from '@dltech/atlas-core'

export type PendingSaid = { text: string; images: readonly SaidImage[] }

export type PendingMessage = PendingSaid & {
  kind: 'message'
  id: string
  taken: boolean
  durable: boolean
}

export type PendingCommand<Command> = {
  kind: 'command'
  id: string
  text: string
  command: Command
}

export type PendingEntry<Command> = PendingMessage | PendingCommand<Command>

export type TakenBack = PendingSaid & { taken: boolean }

export type PendingQueue<Command = never> = {
  subscribe(listener: () => void): () => void
  getSnapshot(): readonly PendingEntry<Command>[]
  enqueue(args: { text: string; images?: readonly SaidImage[] }): void
  enqueueCommand(args: { text: string; command: Command }): void
  takeBackLast(): TakenBack | null
  drain(): readonly PendingSaid[]
  drainCommands(): readonly PendingCommand<Command>[]
  settleTaken(args: { events: readonly Event[] }): void
}

const NOTHING_PENDING: readonly PendingEntry<never>[] = Object.freeze([])

const NOTHING_TAKEN: readonly PendingSaid[] = Object.freeze([])

const NO_IMAGES: readonly SaidImage[] = Object.freeze([])

const isMessage = <Command>(entry: PendingEntry<Command>): entry is PendingMessage =>
  entry.kind === 'message'

const isCommand = <Command>(entry: PendingEntry<Command>): entry is PendingCommand<Command> =>
  entry.kind === 'command'

/**
 * The newest position where the taken messages appear as one run of user-said events, reading from
 * the end so a repeated text matches the latest turn rather than an earlier one.
 */
const runStartIn = (args: {
  events: readonly Event[]
  messages: readonly PendingMessage[]
}): number | null => {
  const { events, messages } = args

  for (let start = events.length - messages.length; start >= 0; start -= 1) {
    const matches = messages.every((message, offset) => {
      const event = events[start + offset]
      return event?.type === 'user-said' && event.text === message.text
    })
    if (matches) return start
  }

  return null
}

export function createPendingQueue<Command = never>(): PendingQueue<Command> {
  let entries: readonly PendingEntry<Command>[] = NOTHING_PENDING
  let snapshot: readonly PendingEntry<Command>[] = entries
  let stamped = 0

  const listeners = new Set<() => void>()

  const settle = (next: readonly PendingEntry<Command>[]): void => {
    entries = next
    snapshot = entries
    for (const listener of [...listeners]) listener()
  }

  const stamp = (): string => {
    stamped += 1
    return `pending-${stamped}`
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },

    getSnapshot: () => snapshot,

    enqueue({ text, images }) {
      settle([
        ...entries,
        { kind: 'message', id: stamp(), text, images: images ?? NO_IMAGES, taken: false, durable: false },
      ])
    },

    enqueueCommand({ text, command }) {
      settle([...entries, { kind: 'command', id: stamp(), text, command }])
    },

    takeBackLast() {
      const last = entries.at(-1)
      if (last === undefined) return null

      settle(entries.slice(0, -1))
      if (last.kind === 'command') return { text: last.text, images: NO_IMAGES, taken: false }
      return { text: last.text, images: last.images, taken: last.taken }
    },

    drain() {
      const waiting = entries.filter(isMessage).filter((entry) => !entry.taken)
      if (waiting.length === 0) return NOTHING_TAKEN

      settle(
        entries.map((entry) =>
          isMessage(entry) && !entry.taken ? { ...entry, taken: true } : entry,
        ),
      )
      return waiting.map((message) => ({ text: message.text, images: message.images }))
    },

    drainCommands() {
      const commands = entries.filter(isCommand)
      if (commands.length === 0) return []

      settle(entries.filter((entry) => !isCommand(entry)))
      return commands
    },

    settleTaken({ events }) {
      const taken = entries.filter(isMessage).filter((entry) => entry.taken)
      if (taken.length === 0) return

      const start = runStartIn({ events, messages: taken })
      if (start === null) return

      if (start + taken.length < events.length) {
        settle(entries.filter((entry) => !(isMessage(entry) && entry.taken)))
        return
      }

      if (taken.every((message) => message.durable)) return

      settle(
        entries.map((entry) => (isMessage(entry) && entry.taken ? { ...entry, durable: true } : entry)),
      )
    },
  }
}
