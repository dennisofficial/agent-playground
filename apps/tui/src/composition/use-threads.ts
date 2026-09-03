import type { KeyEvent } from '@opentui/core'
import { useCallback, useMemo, useRef, useState } from 'react'

import { projectOf } from '@dltech/atlas-core'

import {
  backspace,
  failedToList,
  loadingThreads,
  moveSelection,
  selectedThread,
  threadRows,
  typeInto,
  withThreads,
  type ThreadRow,
  type ThreadsState,
} from '../ui/threads-model'
import { isPrintable } from '../ui/keys/printable'
import type { AtlasApp } from './compose'

export type ThreadsControl = {
  state: ThreadsState | null
  handleOpen: () => void
  handleDismiss: () => void
  handlePick: (row: ThreadRow) => void
  handleKey: (key: KeyEvent) => void
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : 'the conversations could not be listed'

/**
 * OpenTUI parses a whole input burst before React re-renders, so a typed run of keys would all read
 * the same rendered state. The ref is what the handlers read and write; React state draws it.
 */
export function useThreads(args: {
  app: AtlasApp
  activeThreadId: string
  onPick: (threadId: string) => void
}): ThreadsControl {
  const { app, activeThreadId, onPick } = args
  const held = useRef<ThreadsState | null>(null)
  const [state, setState] = useState<ThreadsState | null>(null)

  const put = useCallback((next: ThreadsState | null) => {
    held.current = next
    setState(next)
  }, [])

  const handleOpen = useCallback(() => {
    put(loadingThreads({ now: Date.now() }))

    void app.threads
      .list({ project: projectOf(app.workspace) })
      .then((threads) => {
        const current = held.current
        if (current === null) return

        put(withThreads({ state: current, rows: threadRows({ threads, activeThreadId }) }))
      })
      .catch((error: unknown) => {
        const current = held.current
        if (current === null) return

        put(failedToList({ state: current, reason: reasonOf(error) }))
      })
  }, [activeThreadId, app.threads, app.workspace, put])

  const handleDismiss = useCallback(() => put(null), [put])

  const handlePick = useCallback(
    (row: ThreadRow) => {
      put(null)
      onPick(row.threadId)
    },
    [onPick, put],
  )

  const handleKey = useCallback(
    (key: KeyEvent) => {
      const current = held.current
      if (current === null) return

      if (key.name === 'escape') {
        handleDismiss()
        return
      }

      if (key.name === 'up' || key.name === 'down') {
        put(moveSelection({ state: current, delta: key.name === 'up' ? -1 : 1 }))
        return
      }

      if (key.name === 'return') {
        const row = selectedThread(current)
        if (row !== undefined) handlePick(row)
        return
      }

      if (key.name === 'backspace') {
        put(backspace(current))
        return
      }

      if (isPrintable(key)) put(typeInto({ state: current, text: key.sequence ?? '' }))
    },
    [handleDismiss, handlePick, put],
  )

  return useMemo(
    () => ({ state, handleOpen, handleDismiss, handlePick, handleKey }),
    [handleDismiss, handleKey, handleOpen, handlePick, state],
  )
}
