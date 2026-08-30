export enum EComposerEdge {
  Slab = 'slab',
  Bordered = 'bordered',
  Claude = 'claude',
}

export const SHIPPED_COMPOSER_EDGE = EComposerEdge.Slab

const listeners = new Set<() => void>()

let current: EComposerEdge = SHIPPED_COMPOSER_EDGE

let version = 0

export const subscribeComposerEdge = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const composerEdgeVersion = (): number => version

export const composerEdge = (): EComposerEdge => current

export function applyComposerEdge(next: EComposerEdge): void {
  if (next === current) return
  current = next
  version += 1
  for (const listener of listeners) listener()
}

export const composerEdgeOf = (value: string): EComposerEdge => {
  if (value === EComposerEdge.Bordered) return EComposerEdge.Bordered
  if (value === EComposerEdge.Claude) return EComposerEdge.Claude
  return EComposerEdge.Slab
}
