import type { ThreadId } from '@dltech/atlas-core'
import { useCallback, type RefObject } from 'react'

import type { AtlasApp } from './compose'
import { EOpenMode } from './config'
import {
  openConversation,
  unstartedConversation,
  type OpenedConversation,
} from './open-conversation'

export type ThreadSwap = {
  handleNewConversation: () => void
  handleOpenThread: (threadId: string) => void
}

/**
 * Both verbs end in the same place — a conversation handed to `adopt` — so opening an existing
 * thread reuses the one loader boot already goes through rather than reading the log a second way.
 */
export function useThreadSwap(args: {
  app: AtlasApp
  threadId: ThreadId
  working: RefObject<boolean>
  adopt: (next: OpenedConversation) => void
  onFailure: (reason: string) => void
}): ThreadSwap {
  const { app, threadId, working, adopt, onFailure } = args

  const handleNewConversation = useCallback(() => {
    if (working.current) return

    adopt(unstartedConversation({ ids: app.ids }))
  }, [adopt, app.ids, working])

  const handleOpenThread = useCallback(
    (asked: string) => {
      if (working.current || asked === threadId) return

      void openConversation({
        threads: app.threads,
        log: app.log,
        ledger: app.ledger,
        agents: app.agents,
        ids: app.ids,
        workspace: app.workspace,
        open: { mode: EOpenMode.Resume, threadId: asked },
      }).then((outcome) => {
        if (!outcome.ok) {
          onFailure(outcome.reason)
          return
        }

        adopt(outcome.conversation)
      })
    },
    [
      adopt,
      app.agents,
      app.ids,
      app.ledger,
      app.log,
      app.threads,
      app.workspace,
      onFailure,
      threadId,
      working,
    ],
  )

  return { handleNewConversation, handleOpenThread }
}
