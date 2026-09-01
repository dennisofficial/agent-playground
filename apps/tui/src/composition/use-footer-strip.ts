import type { KeyEvent } from '@opentui/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { caretOnLastRow } from '../ui/composer-caret'
import type { FooterItem } from '../ui/footer-item'
import {
  enterStrip,
  EStripCommand,
  moveStripSelection,
  reconcileStrip,
  selectedStripItem,
  stripCommand,
  type FooterStripState,
} from '../ui/footer-strip'
import type { DraftControls } from '../ui/hooks/use-draft'

export type FooterStripControl = {
  items: readonly FooterItem[]
  state: FooterStripState | null
  handleEnter: () => boolean
  handleLeave: () => void
  handleActivate: (item: FooterItem) => void
  handleKey: (key: KeyEvent) => void
}

/**
 * OpenTUI parses a whole input burst before React re-renders, so the ref is what the handlers read
 * and write and React state only draws it — the same reason `useThreads` mirrors its state.
 */
export function useFooterStrip(args: {
  items: readonly FooterItem[]
  draft: DraftControls
}): FooterStripControl {
  const { items, draft } = args
  const held = useRef<FooterStripState | null>(null)
  const [state, setState] = useState<FooterStripState | null>(null)

  const put = useCallback((next: FooterStripState | null) => {
    held.current = next
    setState(next)
  }, [])

  /**
   * The composer is refocused imperatively rather than left to the `focused` prop: waiting for the
   * next render leaves a frame with nothing focused and no caret anywhere.
   */
  const handleLeave = useCallback(() => {
    put(null)
    draft.editor.current?.focus()
  }, [draft, put])

  /**
   * Entry is a binding that may decline, so an empty row, a blurred composer or a caret with a row
   * still below it all fall through to the textarea's own `move-down`. `editor.focused` subsumes
   * every overlay: `focused={!overlaid}` already blurs the composer whenever anything covers it.
   */
  const handleEnter = useCallback((): boolean => {
    const editor = draft.editor.current
    if (editor === null || !editor.focused) return false

    const onLastRow = caretOnLastRow({
      text: editor.plainText,
      offset: editor.cursorOffset,
      rowEndOffset: editor.editorView.getVisualEOL().offset,
    })
    if (!onLastRow) return false

    const entered = enterStrip(items)
    if (entered === null) return false

    put(entered)
    return true
  }, [draft, items, put])

  /**
   * A click activates without taking the row's selection, and therefore without blurring the
   * composer: the strip owning the keyboard is what makes ⏎ mean "fire this pill again" instead of
   * "send the draft", and a pointer never asked for that.
   */
  const handleActivate = useCallback((item: FooterItem) => item.onActivate?.(), [])

  const handleTypeThrough = useCallback(
    (text: string) => {
      handleLeave()

      const editor = draft.editor.current
      if (editor === null) return

      editor.insertText(text)
      draft.sync(editor.plainText)
    },
    [draft, handleLeave],
  )

  /**
   * The owner list that routes here is a render behind the ref, so the rest of a burst still
   * arrives after a printable has already left the row — with `preventDefault` long since called,
   * nothing else would put those characters in the draft.
   */
  const handleKey = useCallback(
    (key: KeyEvent) => {
      const command = stripCommand(key)
      if (command === null) return

      const current = held.current
      if (current === null) {
        if (command.kind === EStripCommand.TypeThrough) handleTypeThrough(command.text)
        return
      }

      if (command.kind === EStripCommand.Move) {
        put(moveStripSelection({ state: current, items, delta: command.delta }))
        return
      }

      if (command.kind === EStripCommand.Activate) {
        const item = selectedStripItem({ state: current, items })
        if (item !== undefined) handleActivate(item)
        return
      }

      if (command.kind === EStripCommand.Leave) {
        handleLeave()
        return
      }

      handleTypeThrough(command.text)
    },
    [handleActivate, handleLeave, handleTypeThrough, items, put],
  )

  useEffect(() => {
    const reconciled = reconcileStrip({ state: held.current, items })
    if (reconciled === held.current) return

    put(reconciled)
    if (reconciled === null) draft.editor.current?.focus()
  }, [draft, items, put])

  return useMemo(
    () => ({ items, state, handleEnter, handleLeave, handleActivate, handleKey }),
    [handleActivate, handleEnter, handleKey, handleLeave, items, state],
  )
}
