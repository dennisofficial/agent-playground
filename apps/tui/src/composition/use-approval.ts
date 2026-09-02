import type { EventDraft } from '@dltech/atlas-core'
import type { KeyEvent } from '@opentui/core'
import { useCallback, useMemo, useState } from 'react'

import {
  answerDrafts,
  EApprovalChoice,
  moveSelection,
  offersToStopAsking,
  openApproval,
  resolve,
  STOP_ASKING_KEY,
  type ApprovalQuestion,
  type ApprovalState,
} from '../ui/approval-model'

export type ApprovalControl = {
  state: ApprovalState | null
  handleOpen: (question: ApprovalQuestion) => void
  handleDismiss: () => void
  handlePick: (choice: EApprovalChoice) => void
  handleKey: (key: KeyEvent) => void
}

export function useApproval(args: {
  onAnswer: (drafts: readonly EventDraft[]) => void
}): ApprovalControl {
  const [state, setState] = useState<ApprovalState | null>(null)
  const { onAnswer } = args

  const handleOpen = useCallback(
    (question: ApprovalQuestion) => setState(openApproval(question)),
    [],
  )

  const handlePick = useCallback(
    (choice: EApprovalChoice) => {
      if (state === null) return

      setState(null)
      onAnswer(
        answerDrafts({
          callId: state.callId,
          choice,
          grantables: state.grantables,
          reason: state.reason,
        }),
      )
    },
    [onAnswer, state],
  )

  const handleDismiss = useCallback(() => handlePick(EApprovalChoice.Decline), [handlePick])

  const handleKey = useCallback(
    (key: KeyEvent) => {
      if (state === null) return

      if (key.name === 'escape') {
        handleDismiss()
        return
      }

      if (key.name === STOP_ASKING_KEY && !key.ctrl && !key.meta && offersToStopAsking(state)) {
        handlePick(EApprovalChoice.Always)
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
