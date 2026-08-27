import type { KeyBinding, PlacedBinding } from './binding'

export type KeyRegistry = {
  subscribe(listener: () => void): () => void
  snapshot(): readonly PlacedBinding[]
  register(bindings: readonly KeyBinding[]): () => void
}

const NOTHING_BOUND: readonly PlacedBinding[] = Object.freeze([])

export function createKeyRegistry(): KeyRegistry {
  const listeners = new Set<() => void>()
  const registered = new Set<readonly PlacedBinding[]>()
  let placed = 0
  let flattened: readonly PlacedBinding[] = NOTHING_BOUND

  const reflatten = () => {
    flattened = registered.size === 0 ? NOTHING_BOUND : [...registered].flat()
    for (const listener of [...listeners]) listener()
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },

    snapshot: () => flattened,

    register(bindings) {
      const entry = bindings.map((binding) => ({ ...binding, placed: (placed += 1) }))

      registered.add(entry)
      reflatten()

      return () => {
        registered.delete(entry)
        reflatten()
      }
    },
  }
}
