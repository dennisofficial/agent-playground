import { theme } from './theme'

export const CONTEXT_WARN_PERCENT = 75

export const COMPACT_COMMAND = '/compact'

export function isContextWarning(percent: number): boolean {
  return percent > CONTEXT_WARN_PERCENT
}

export function contextTone(percent: number): string {
  return isContextWarning(percent) ? theme.warn : theme.meta
}
