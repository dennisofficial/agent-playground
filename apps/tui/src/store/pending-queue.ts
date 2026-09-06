import type { SaidImage } from '@dltech/atlas-core'

export type PendingSaid = { text: string; images: readonly SaidImage[] }

export type PendingMessage = PendingSaid & { kind: 'message'; id: string }

export type PendingCommand<Command> = {
  kind: 'command'
  id: string
  text: string
  command: Command
}

export type PendingEntry<Command> = PendingMessage | PendingCommand<Command>

export type PendingQueue<Command = never> = {
  subscribe(listener: () => void): () => void
  getSnapshot(): readonly PendingEntry<Command>[]
  enqueue(args: { text: string; images?: readonly SaidImage[] }): void
  enqueueCommand(args: { text: string; command: Command }): void
  takeBackLast(): PendingSaid | null
  drain(): readonly PendingSaid[]
  drainCommands(): readonly PendingCommand<Command>[]
}

const NOTHING_PENDING: readonly PendingEntry<never>[] = Object.freeze([])

const NOTHING_TAKEN: readonly PendingSaid[] = Object.freeze([])

const NO_COMMANDS: readonly PendingCommand<never>[] = Object.freeze([])

const NO_IMAGES: readonly SaidImage[] = Object.freeze([])

const isCommand = <Command>(entry: PendingEntry<Command>): entry is PendingCommand<Command> =>
  entry.kind === 'command'

/**
 * Everything here is undelivered: the loop takes messages out of it and the settle path takes
 * commands, and what either has taken lives in the event log from then on — never here.
 */
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
      settle([...entries, { kind: 'message', id: stamp(), text, images: images ?? NO_IMAGES }])
    },

    enqueueCommand({ text, command }) {
      settle([...entries, { kind: 'command', id: stamp(), text, command }])
    },

    takeBackLast() {
      const last = entries.at(-1)
      if (last === undefined) return null

      settle(entries.slice(0, -1))
      if (last.kind === 'command') return { text: last.text, images: NO_IMAGES }
      return { text: last.text, images: last.images }
    },

    drain() {
      const messages = entries.filter((entry) => entry.kind === 'message')
      if (messages.length === 0) return NOTHING_TAKEN

      settle(entries.filter(isCommand))
      return messages.map((message) => ({ text: message.text, images: message.images }))
    },

    drainCommands() {
      const commands = entries.filter(isCommand)
      if (commands.length === 0) return NO_COMMANDS

      settle(entries.filter((entry) => !isCommand(entry)))
      return commands
    },
  }
}
