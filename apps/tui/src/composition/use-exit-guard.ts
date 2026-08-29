import type { KeyEvent } from '@opentui/core'
import { useCallback, useMemo, useState } from 'react'

import {
  EExitChoice,
  moveSelection,
  openExitGuard,
  resolve,
  type ExitGuardState,
} from '../ui/exit-guard-model'

export type ExitGuardControl = {
  state: ExitGuardState | null
  handleOpen: () => void
  handleDismiss: () => void
  handlePick: (choice: EExitChoice) => void
  handleKey: (key: KeyEvent) => void
}

export function useExitGuard(args: { onExit: () => void }): ExitGuardControl {
  const [state, setState] = useState<ExitGuardState | null>(null)
  const { onExit } = args

  const handleOpen = useCallback(() => setState(openExitGuard()), [])

  const handleDismiss = useCallback(() => setState(null), [])

  const handlePick = useCallback(
    (choice: EExitChoice) => {
      if (choice === EExitChoice.Detach) return

      setState(null)
      if (choice === EExitChoice.StopAndExit) onExit()
    },
    [onExit],
  )

  const handleKey = useCallback(
    (key: KeyEvent) => {
      if (state === null) return

      if (key.name === 'escape') {
        handleDismiss()
        return
      }

      if (key.name === 'return') {
        const choice = resolve(state)
        if (choice !== null) handlePick(choice)
        return
      }

      if (key.name === 'up' || key.name === 'down') {
        setState(moveSelection({ state, delta: key.name === 'up' ? -1 : 1 }))
      }
    },
    [handleDismiss, handlePick, state],
  )

  return useMemo(
    () => ({ state, handleOpen, handleDismiss, handlePick, handleKey }),
    [handleDismiss, handleKey, handleOpen, handlePick, state],
  )
}
