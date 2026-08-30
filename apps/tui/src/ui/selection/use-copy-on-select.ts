import type { Selection } from '@opentui/core'
import { useRenderer, useSelectionHandler } from '@opentui/react'
import { useRef } from 'react'

import { copyToClipboard } from '../clipboard'
import { ENoticeTone, notify } from '../notice-store'
import { glyph } from '../theme'
import { selectedText } from './selected-text'

export function copiedLabel(text: string): string {
  const lines = text.trim().split('\n').length
  return lines > 1 ? `${glyph.copy} copied ${lines} lines` : `${glyph.copy} copied`
}

export function useCopyOnSelect(): void {
  const renderer = useRenderer()
  const last = useRef<{ selection: Selection; text: string } | null>(null)

  useSelectionHandler((selection) => {
    if (selection.isDragging) return

    const text = selectedText({ selection, renderer })
    if (text.trim().length === 0) return
    if (last.current?.selection === selection && last.current.text === text) return

    last.current = { selection, text }

    if (!copyToClipboard({ renderer, text })) {
      notify({ text: 'clipboard unavailable', tone: ENoticeTone.Warn })
      return
    }

    notify({ text: copiedLabel(text) })
  })
}
