import type { KeyEvent } from '@opentui/core'
import { useCallback, useMemo, useRef, useState } from 'react'

import type { CommandSpec } from '@dltech/atlas-core'

import {
  completedText,
  moveCommandSelection,
  openCommandMenu,
  selectedCommand,
  type CommandMenuState,
} from '../ui/command-menu-model'

export type CommandMenuControl = {
  state: CommandMenuState | null
  handleTextChanged: (text: string) => void
  handleKey: (key: KeyEvent) => boolean
  handleDismiss: () => void
}

export function useCommandMenu(args: {
  specs: readonly CommandSpec[]
  onComplete: (text: string) => void
}): CommandMenuControl {
  const [state, setState] = useState<CommandMenuState | null>(null)
  const typed = useRef('')
  const { specs, onComplete } = args

  const handleTextChanged = useCallback(
    (text: string) => {
      typed.current = text
      setState(openCommandMenu({ text, specs }))
    },
    [specs],
  )

  const handleDismiss = useCallback(() => setState(null), [])

  const handleKey = useCallback(
    (key: KeyEvent): boolean => {
      if (state === null) return false

      if (key.name === 'escape') {
        setState(null)
        return true
      }

      if (key.name === 'up' || key.name === 'down') {
        setState(moveCommandSelection({ state, delta: key.name === 'up' ? -1 : 1 }))
        return true
      }

      if (key.name !== 'tab' && key.name !== 'return') return false

      const spec = selectedCommand(state)
      if (spec === null) return false
      if (key.name === 'return' && state.query === spec.name) return false

      setState(null)
      onComplete(completedText({ text: typed.current, spec }))
      return true
    },
    [onComplete, state],
  )

  return useMemo(
    () => ({ state, handleTextChanged, handleKey, handleDismiss }),
    [handleDismiss, handleKey, handleTextChanged, state],
  )
}
