export enum EBlockDensity {
  Compact = 'compact',
  Comfort = 'comfort',
}

export const SHIPPED_DENSITY = EBlockDensity.Comfort

const listeners = new Set<() => void>()

let current: EBlockDensity = SHIPPED_DENSITY

let version = 0

export const subscribeDensity = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const densityVersion = (): number => version

export const blockDensity = (): EBlockDensity => current

export function applyBlockDensity(next: EBlockDensity): void {
  if (next === current) return
  current = next
  version += 1
  for (const listener of listeners) listener()
}

export const blockDensityOf = (value: string): EBlockDensity =>
  value === EBlockDensity.Compact ? EBlockDensity.Compact : EBlockDensity.Comfort
