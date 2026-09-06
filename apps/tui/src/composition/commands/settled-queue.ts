import type { CommandEffect } from './local-command'

export type QueuedSettled = {
  name: string
  dropsQueue: boolean
  run: () => CommandEffect | Promise<CommandEffect>
}

export type SettledQueue = {
  names(): readonly string[]
  toggle(entry: QueuedSettled): boolean
  drain(): readonly QueuedSettled[]
  clear(): void
}

/**
 * Settled commands submitted mid-turn wait here rather than being refused. Submitting the same
 * command again takes it back out, which is the only cancel the queue needs: the composer is the
 * surface the entry went in through.
 */
export function createSettledQueue(): SettledQueue {
  let queued: readonly QueuedSettled[] = []

  return {
    names: () => queued.map((entry) => entry.name),

    toggle(entry) {
      const held = queued.findIndex((one) => one.name === entry.name)
      if (held >= 0) {
        queued = queued.filter((one) => one.name !== entry.name)
        return false
      }

      queued = [...queued, entry]
      return true
    },

    drain() {
      const handed = queued
      queued = []
      return handed
    },

    clear() {
      queued = []
    },
  }
}

const slashed = (names: readonly string[]): string => names.map((name) => `/${name}`).join(', ')

export const queuedNotice = (names: readonly string[]): string =>
  names.length === 1
    ? `/${names[0]} queued — runs when this turn finishes`
    : `queued for when this turn finishes: ${slashed(names)}`

export const unqueuedNotice = (name: string): string => `/${name} taken out of the queue`

/**
 * A thread-swapping command discards whatever was queued behind it: messages were typed for the
 * conversation it replaces, and commands queued after it were meant for that same conversation.
 */
export function droppedNotice(args: {
  command: string
  messages: number
  commands: readonly string[]
}): string | null {
  const dropped: string[] = []
  if (args.messages === 1) dropped.push('a queued message')
  if (args.messages > 1) dropped.push(`${args.messages} queued messages`)
  if (args.commands.length > 0) dropped.push(slashed(args.commands))
  if (dropped.length === 0) return null

  return `/${args.command} dropped ${dropped.join(' and ')}`
}
