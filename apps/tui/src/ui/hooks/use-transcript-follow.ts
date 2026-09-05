import type { ScrollBoxRenderable } from '@opentui/core'
import { useCallback, useEffect, useRef, type RefObject } from 'react'

import { isPinnedToBottom } from '../scroll-position'
import { observeScroll } from '../scroll-signal'
import { peekAbove, type PeekCandidate } from '../transcript-peek'
import { applyTranscriptViewport, resetTranscriptViewport } from '../transcript-viewport-store'

const NOTHING_TO_PEEK: ReadonlySet<string> = Object.freeze(new Set<string>())

export type TranscriptFollow = {
  scroller: RefObject<ScrollBoxRenderable | null>
  handleJumpToBottom: () => void
  handleJumpTo: (key: string) => void
}

const candidatesOf = (
  box: ScrollBoxRenderable,
  keys: ReadonlySet<string>,
): readonly PeekCandidate[] =>
  box.content
    .getChildren()
    .filter((child) => keys.has(child.id))
    .map((child) => ({ key: child.id, top: child.y }))

export function useTranscriptFollow(
  args: {
    scroller?: RefObject<ScrollBoxRenderable | null>
    anchorId?: string | null
    sends?: number
    peekKeys?: ReadonlySet<string>
    onTick?: () => void
    offsetOfKey?: (key: string) => number | null
  } = {},
): TranscriptFollow {
  const ownScroller = useRef<ScrollBoxRenderable | null>(null)
  const scroller = args.scroller ?? ownScroller
  const landed = useRef(false)
  const anchorId = useRef<string | null>(args.anchorId ?? null)
  const peekKeys = useRef<ReadonlySet<string>>(args.peekKeys ?? NOTHING_TO_PEEK)
  const onTick = useRef<(() => void) | undefined>(args.onTick)
  onTick.current = args.onTick
  const offsetOfKey = useRef<((key: string) => number | null) | undefined>(args.offsetOfKey)
  offsetOfKey.current = args.offsetOfKey
  const sends = args.sends ?? 0

  const evaluate = useCallback(() => {
    const box = scroller.current
    if (!box) return

    const anchor = anchorId.current
    if (anchor !== null && !landed.current) {
      if (!box.content.findDescendantById(anchor)) return
      box.scrollChildIntoView(anchor)
      landed.current = true
    }

    applyTranscriptViewport({
      tailing: isPinnedToBottom({
        scrollTop: box.scrollTop,
        scrollHeight: box.scrollHeight,
        viewportHeight: box.viewport.height,
      }),
      peekKey: peekAbove({
        candidates: candidatesOf(box, peekKeys.current),
        viewportTop: box.viewport.y,
      }),
    })

    onTick.current?.()
  }, [])

  useEffect(() => {
    const box = scroller.current
    if (!box) return

    const stop = observeScroll(box, evaluate)
    evaluate()

    return () => {
      stop()
      resetTranscriptViewport()
    }
  }, [evaluate])

  useEffect(() => {
    const next = args.anchorId ?? null
    if (next !== anchorId.current) landed.current = false
    anchorId.current = next
    evaluate()
  }, [args.anchorId, evaluate])

  useEffect(() => {
    peekKeys.current = args.peekKeys ?? NOTHING_TO_PEEK
    evaluate()
  }, [args.peekKeys, evaluate])

  const handleJumpToBottom = useCallback(() => {
    const box = scroller.current
    if (!box) return
    box.scrollTo(Math.max(0, box.scrollHeight - box.viewport.height))
    evaluate()
  }, [evaluate])

  /**
   * `scrollChildIntoView` refuses to move an entry taller than the viewport, which is exactly the
   * long message worth jumping back to, so the offset is applied directly.
   */
  const handleJumpTo = useCallback(
    (key: string) => {
      const box = scroller.current
      if (!box) return
      const child = box.content.findDescendantById(key)
      if (!child) {
        const offset = offsetOfKey.current?.(key)
        if (offset === null || offset === undefined) return
        box.scrollTo(Math.max(0, offset))
        evaluate()
        return
      }
      box.scrollTo(Math.max(0, box.scrollTop + (child.y - box.viewport.y)))
      evaluate()
    },
    [evaluate],
  )

  useEffect(() => {
    if (sends === 0) return
    handleJumpToBottom()
  }, [sends, handleJumpToBottom])

  return { scroller, handleJumpToBottom, handleJumpTo }
}
