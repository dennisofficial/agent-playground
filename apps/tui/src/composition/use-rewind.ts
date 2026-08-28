import type { KeyEvent } from '@opentui/core'
import { useCallback, useMemo, useState } from 'react'

import type { Event } from '@dltech/atlas-core'

import {
  chooseVerb,
  clearVerb,
  isCurrentRow,
  moveSelection,
  openRewind,
  resolve,
  verbsFor,
  type RewindChoice,
  type RewindState,
} from '../ui/rewind-model'

export type RewindControl = {
  state: RewindState | null
  handleOpen: () => void
  handleDismiss: () => void
  handlePick: (choice: RewindChoice) => void
  handleKey: (key: KeyEvent) => void
}

export function useRewind(args: {
  events: () => readonly Event[]
  onPick: (choice: RewindChoice) => void
}): RewindControl {
  const [state, setState] = useState<RewindState | null>(null)
  const { events, onPick } = args

  const handleOpen = useCallback(() => setState(openRewind({ events: events() })), [events])

  const handleDismiss = useCallback(() => setState(null), [])

  const handlePick = useCallback(
    (choice: RewindChoice) => {
      setState(null)
      onPick(choice)
    },
    [onPick],
  )

  const handleKey = useCallback(
    (key: KeyEvent) => {
      if (state === null) return

      if (key.name === 'escape') {
        if (state.verb === null) {
          handleDismiss()
          return
        }
        setState(clearVerb({ state }))
        return
      }

      if (key.name === 'return') {
        if (isCurrentRow(state)) {
          handleDismiss()
          return
        }

        if (state.verb === null) {
          const [first] = verbsFor({ state })
          if (first !== undefined) setState(chooseVerb({ state, verb: first }))
          return
        }

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
