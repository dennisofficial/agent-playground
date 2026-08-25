import type { TextareaRenderable } from '@opentui/core'
import { useCallback, useMemo, useRef, useState, type RefObject } from 'react'

/**
 * The prompt, as a handle onto the native buffer that owns it. The buffer is the truth and `value`
 * mirrors it, so a render can ask how long the draft is without reading a renderable mid-render.
 */
export type DraftControls = {
  value: string
  editor: RefObject<TextareaRenderable | null>
  setValue: (next: string) => void
  clear: () => void
  sync: (text: string) => void
  initial: string
}

export function useDraft(initial = ''): DraftControls {
  const [value, setValue] = useState(initial)
  const editor = useRef<TextareaRenderable | null>(null)
  const seed = useRef(initial)

  const sync = useCallback((text: string) => setValue(text), [])

  const replace = useCallback((next: string) => {
    const target = editor.current
    if (target) {
      target.replaceText(next)
      target.cursorOffset = next.length
    }
    setValue(next)
  }, [])

  const clear = useCallback(() => replace(''), [replace])

  return useMemo(
    () => ({ value, editor, setValue: replace, clear, sync, initial: seed.current }),
    [value, replace, clear, sync],
  )
}
