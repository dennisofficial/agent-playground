import type { ContextPressure } from './catalog'

export function contextPressure(args: { used: number; window: number }): ContextPressure {
  const { used, window } = args
  if (window <= 0) return { used, window, fraction: 0, percent: 0 }

  const fraction = Math.min(1, Math.max(0, used / window))
  return { used, window, fraction, percent: Math.round(fraction * 100) }
}
