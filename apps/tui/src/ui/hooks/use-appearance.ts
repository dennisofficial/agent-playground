import { useSyncExternalStore } from 'react'

import { composerEdgeVersion, subscribeComposerEdge } from '../composer-edge-store'
import { densityVersion, subscribeDensity } from '../density-store'
import { paletteVersion, subscribePalette } from '../palette-store'

/**
 * `theme`, the block density and the composer edge are read as globals rather than passed down, so
 * a component memoised on its props would keep painting the old look after the operator changed
 * one. Subscribing here is what lets a memoised piece of chrome repaint for an appearance change
 * and nothing else.
 */
export function useAppearance(): void {
  useSyncExternalStore(subscribePalette, paletteVersion)
  useSyncExternalStore(subscribeDensity, densityVersion)
  useSyncExternalStore(subscribeComposerEdge, composerEdgeVersion)
}
