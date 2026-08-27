import { createContext, useContext, useEffect, useRef, useSyncExternalStore } from 'react'

import type { KeyBinding, PlacedBinding } from './binding'
import { createKeyRegistry, type KeyRegistry } from './registry'

export const KeyRegistryContext = createContext<KeyRegistry>(createKeyRegistry())

export const useKeyRegistry = (): KeyRegistry => useContext(KeyRegistryContext)

const signatureOf = (bindings: readonly KeyBinding[]): string =>
  bindings.map((binding) => `${binding.layer}:${binding.chord}:${binding.hint}`).join('|')

export function useKeyBindings(bindings: readonly KeyBinding[]): void {
  const registry = useKeyRegistry()
  const latest = useRef(bindings)
  latest.current = bindings

  const signature = signatureOf(bindings)

  useEffect(
    () =>
      registry.register(
        latest.current.map((binding, index) => ({
          ...binding,
          run: () => {
            const current = latest.current[index]
            return current === undefined ? false : current.run()
          },
        })),
      ),
    [registry, signature],
  )
}

export const useBoundKeys = (): readonly PlacedBinding[] => {
  const registry = useKeyRegistry()
  return useSyncExternalStore(registry.subscribe, registry.snapshot)
}
