import { useSyncExternalStore } from 'react'

import { subscribeTerminalFocus, terminalFocus, type ETerminalFocus } from '../focus-store'

export function useTerminalFocus(): ETerminalFocus {
  return useSyncExternalStore(subscribeTerminalFocus, terminalFocus)
}
