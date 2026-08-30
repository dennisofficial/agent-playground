import type { KeyEvent } from '@opentui/core'
import { useCallback, useMemo, useRef, useState } from 'react'

import type { DirectoryEntry } from '@dltech/atlas-core'
import type { FileBrowser } from '@dltech/atlas-harness'

import {
  completedMention,
  mentionQueryOf,
  moveFileSelection,
  openFileMenu,
  type FileMenuState,
} from '../ui/file-menu-model'

export type FileMenuControl = {
  state: FileMenuState | null
  handleTextChanged: (text: string) => void
  handleKey: (key: KeyEvent) => boolean
  handleDismiss: () => void
}

/**
 * A level is read asynchronously, so a listing that lands after the developer has typed on is
 * dropped rather than shown: only the newest ticket may set the menu.
 */
export function useFileMenu(args: {
  files?: FileBrowser | undefined
  onComplete: (text: string) => void
}): FileMenuControl {
  const [state, setState] = useState<FileMenuState | null>(null)
  const typed = useRef('')
  const asked = useRef(0)
  const { files, onComplete } = args

  const handleTextChanged = useCallback(
    (text: string) => {
      typed.current = text
      asked.current += 1

      const query = mentionQueryOf(text)
      if (query === null || files === undefined) {
        setState(null)
        return
      }

      const ticket = asked.current
      void files.list(query.directory).then((entries: readonly DirectoryEntry[]) => {
        if (ticket !== asked.current) return
        setState(openFileMenu({ query, entries }))
      })
    },
    [files],
  )

  const handleDismiss = useCallback(() => {
    asked.current += 1
    setState(null)
  }, [])

  const handleKey = useCallback(
    (key: KeyEvent): boolean => {
      if (state === null) return false

      if (key.name === 'escape') {
        handleDismiss()
        return true
      }

      if (key.name === 'up' || key.name === 'down') {
        setState(moveFileSelection({ state, delta: key.name === 'up' ? -1 : 1 }))
        return true
      }

      if (key.name !== 'tab' && key.name !== 'return') return false

      const completed = completedMention({ text: typed.current, state })
      if (completed === null) return false
      if (key.name === 'return' && completed === typed.current) return false

      setState(null)
      onComplete(completed)
      return true
    },
    [handleDismiss, onComplete, state],
  )

  return useMemo(
    () => ({ state, handleTextChanged, handleKey, handleDismiss }),
    [handleDismiss, handleKey, handleTextChanged, state],
  )
}
