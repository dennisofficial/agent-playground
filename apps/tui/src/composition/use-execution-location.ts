import { EExecutionLocation, type ThreadId } from '@dltech/atlas-core'
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'

import type { AtlasApp } from './compose'
import { resolveExecutionLocation } from './execution-preference'

export type ExecutionLocationControl = {
  location: EExecutionLocation
  handleSet: (location: EExecutionLocation) => void
}

/**
 * The same two-preference split as the model: the thread column is where the conversation was last
 * switched, the settings row is only what a conversation with nothing of its own begins on. The
 * cell is the truth the assembly pipeline reads synchronously, so a switch reaches the next turn
 * without waiting on the store.
 */
export function useExecutionLocation(args: {
  app: AtlasApp
  threadId: ThreadId
  stored: EExecutionLocation | undefined
  started: boolean
}): ExecutionLocationControl {
  const { app, threadId, stored, started } = args
  const launching = useRef(true)
  const wasStarted = useRef(started)

  const location = useSyncExternalStore(
    app.executionLocation.subscribe,
    app.executionLocation.current,
  )

  useEffect(() => {
    const pinned = launching.current && app.executionPinned
    launching.current = false
    if (pinned) return

    const resolved = resolveExecutionLocation({
      requested: undefined,
      stored,
      settled: app.settings.snapshot().resolution,
    })
    app.executionLocation.set(resolved)
    app.executionLocation.note({ threadId, location: resolved })
  }, [app, stored, threadId])

  useEffect(() => {
    const opening = !wasStarted.current && started
    wasStarted.current = started
    if (!opening) return

    void app.threads
      .chooseExecutionLocation({ threadId, location: app.executionLocation.current() })
      .catch(() => undefined)
  }, [app, started, threadId])

  const handleSet = useCallback(
    (next: EExecutionLocation) => {
      app.executionLocation.set(next)
      app.executionLocation.note({ threadId, location: next })
      if (!started) return

      void app.threads.chooseExecutionLocation({ threadId, location: next }).catch(() => undefined)
    },
    [app, started, threadId],
  )

  return { location, handleSet }
}
