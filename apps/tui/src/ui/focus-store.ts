export enum ETerminalFocus {
  Unknown = 'unknown',
  Focused = 'focused',
  Blurred = 'blurred',
}

const listeners = new Set<() => void>()

let current: ETerminalFocus = ETerminalFocus.Unknown

export const subscribeTerminalFocus = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const terminalFocus = (): ETerminalFocus => current

export function applyTerminalFocus(next: ETerminalFocus): void {
  if (next === current) return
  current = next
  for (const listener of listeners) listener()
}
