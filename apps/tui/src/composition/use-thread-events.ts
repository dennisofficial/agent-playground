import type { Event, ThreadId } from '@dltech/atlas-core'
import { useCallback, useState } from 'react'

import { trailingSaid, type ConversationStore } from '../store'
import type { AtlasApp } from './compose'
import { readThreadSpend } from './thread-spend'

export type ThreadEvents = {
  events: readonly Event[]
  setEvents: (events: readonly Event[]) => void
  refresh: () => Promise<void>
}

/**
 * The log is read whole rather than appended to: the loop owns what lands, so the only honest way to
 * know the rows is to ask for them. The store is fed the same read, so the transcript and the
 * hook's own copy cannot disagree.
 */
export function useThreadEvents(args: {
  app: AtlasApp
  threadId: ThreadId
  store: ConversationStore
  initial: readonly Event[]
}): ThreadEvents {
  const { app, threadId, store } = args
  const [events, setEvents] = useState<readonly Event[]>(args.initial)
  const pending = app.pending

  const refresh = useCallback(async () => {
    const [read, spent] = await Promise.all([
      app.log.read({ threadId }),
      readThreadSpend({ ledger: app.ledger, threadId }),
    ])
    store.setEvents({ events: read, turns: spent.turns })
    setEvents(read)
    pending.settleTaken({ landed: trailingSaid(read) })
  }, [app.ledger, app.log, pending, store, threadId])

  return { events, setEvents, refresh }
}
