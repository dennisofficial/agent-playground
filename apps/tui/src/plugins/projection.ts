import type { Event } from '@dltech/atlas-core'
import { useSyncExternalStore } from 'react'

const NO_EVENTS: readonly Event[] = Object.freeze([])

export type ProjectionFold<TValue> = (args: { events: readonly Event[] }) => TValue

/**
 * `TValue` appears only in output positions, so a projection of a concrete value is assignable to
 * `PluginProjection<unknown>` and the contribution list can hold projections of differing shapes
 * without the plugin reaching back through a string key to read its own.
 */
export type PluginProjection<TValue> = {
  readonly id: string
  current: () => TValue
  version: () => number
  subscribe: (listener: () => void) => () => void
  use: () => TValue
  publish: (args: { events: readonly Event[] }) => void
}

export type ContributedProjection = {
  pluginId: string
  projection: PluginProjection<unknown>
}

export const NO_PROJECTIONS: readonly ContributedProjection[] = Object.freeze([])

export function defineProjection<TValue>(args: {
  id: string
  fold: ProjectionFold<TValue>
}): PluginProjection<TValue> {
  const listeners = new Set<() => void>()

  let value = args.fold({ events: NO_EVENTS })
  let version = 0
  let folded: readonly Event[] = NO_EVENTS

  const current = (): TValue => value
  const versionOf = (): number => version
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  return {
    id: args.id,
    current,
    version: versionOf,
    subscribe,
    use: () => {
      useSyncExternalStore(subscribe, versionOf)
      return current()
    },
    publish: ({ events }) => {
      if (events === folded) return

      folded = events
      const next = args.fold({ events })
      if (next === value) return

      value = next
      version += 1
      for (const listener of [...listeners]) listener()
    },
  }
}

const brokenProjections = new WeakSet<PluginProjection<unknown>>()

/**
 * A fold runs on every republish, so one that throws would take the transcript down with it and do
 * so once per frame. The first throw retires that projection and is reported; the rest keep folding.
 */
export function publishProjections(args: {
  projections: readonly ContributedProjection[]
  events: readonly Event[]
}): readonly string[] {
  const broke: string[] = []

  for (const contributed of args.projections) {
    if (brokenProjections.has(contributed.projection)) continue

    try {
      contributed.projection.publish({ events: args.events })
    } catch {
      brokenProjections.add(contributed.projection)
      broke.push(contributed.pluginId)
    }
  }

  return broke
}
