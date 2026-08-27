import type { KeyEvent } from '@opentui/core'
import { useCallback, useMemo, useState } from 'react'

import { MODEL_CATALOG, type EEffort } from '@dltech/atlas-core'

import {
  adjustEffort,
  moveSelection,
  openSwitcher,
  resolve,
  type SwitcherChoice,
  type SwitcherState,
} from '../ui/switcher-model'
import { modelIsReachable } from './model-selection'

export type SwitcherControl = {
  state: SwitcherState | null
  handleOpen: () => void
  handleDismiss: () => void
  handlePick: (choice: SwitcherChoice) => void
  handleKey: (key: KeyEvent) => void
}

export function useSwitcher(args: {
  activeModelId: string
  effort: EEffort
  onPick: (choice: SwitcherChoice) => void
}): SwitcherControl {
  const [state, setState] = useState<SwitcherState | null>(null)
  const { activeModelId, effort, onPick } = args

  const handleOpen = useCallback(
    () =>
      setState(
        openSwitcher({
          models: MODEL_CATALOG,
          activeModelId,
          effort,
          availability: modelIsReachable,
        }),
      ),
    [activeModelId, effort],
  )

  const handleDismiss = useCallback(() => setState(null), [])

  const handlePick = useCallback(
    (choice: SwitcherChoice) => {
      setState(null)
      onPick(choice)
    },
    [onPick],
  )

  const handleKey = useCallback(
    (key: KeyEvent) => {
      if (state === null) return

      if (key.name === 'escape') {
        handleDismiss()
        return
      }

      if (key.name === 'return') {
        handlePick(resolve({ state, models: MODEL_CATALOG }))
        return
      }

      if (key.name === 'up' || key.name === 'down') {
        setState(
          moveSelection({
            state,
            delta: key.name === 'up' ? -1 : 1,
            models: MODEL_CATALOG,
            availability: modelIsReachable,
          }),
        )
        return
      }

      if (key.name === 'left' || key.name === 'right') {
        setState(adjustEffort({ state, delta: key.name === 'left' ? -1 : 1 }))
      }
    },
    [handleDismiss, handlePick, state],
  )

  return useMemo(
    () => ({ state, handleOpen, handleDismiss, handlePick, handleKey }),
    [handleDismiss, handleKey, handleOpen, handlePick, state],
  )
}
