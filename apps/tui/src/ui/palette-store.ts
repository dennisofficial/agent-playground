import { type Palette, SHIPPED_PALETTE, theme } from './palette'

type Listener = () => void

const listeners = new Set<Listener>()
const invalidators = new Set<() => void>()

let version = 0

export function onPaletteChange(invalidate: () => void): void {
  invalidators.add(invalidate)
}

export const subscribePalette = (listener: Listener): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const paletteVersion = (): number => version

export function applyPalette(next: Partial<Palette>): void {
  Object.assign(theme, next)
  version += 1
  dropStaleCaches()
  repaintSubscribers()
}

export function resetPalette(): void {
  applyPalette(structuredClone(SHIPPED_PALETTE))
}

function dropStaleCaches(): void {
  for (const invalidate of invalidators) invalidate()
}

function repaintSubscribers(): void {
  for (const listener of listeners) listener()
}
