import type { ScrollBoxRenderable } from '@opentui/core'
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

import { isPinnedToBottom } from '../scroll-position'

/**
 * OpenTUI's scrollbox emits no scroll event, and the wheel, a drag and sticky-scroll following a
 * turn all move it without passing through React — so where the transcript is sitting is polled.
 */
const POLL_MS = 250

export type TranscriptFollow = {
  scroller: RefObject<ScrollBoxRenderable | null>
  pinned: boolean
  handleJumpToBottom: () => void
}

export function useTranscriptFollow(args: { anchorId?: string | null } = {}): TranscriptFollow {
  const scroller = useRef<ScrollBoxRenderable | null>(null)
  const [pinned, setPinned] = useState(true)
  const landed = useRef(false)
  const anchorId = args.anchorId ?? null

  useEffect(() => {
    const timer = setInterval(() => {
      const box = scroller.current
      if (!box) return

      if (anchorId !== null && !landed.current) {
        if (!box.content.findDescendantById(anchorId)) return
        box.scrollChildIntoView(anchorId)
        landed.current = true
        return
      }

      setPinned(
        isPinnedToBottom({
          scrollTop: box.scrollTop,
          scrollHeight: box.scrollHeight,
          viewportHeight: box.viewport.height,
        }),
      )
    }, POLL_MS)

    return () => clearInterval(timer)
  }, [anchorId])

  const handleJumpToBottom = useCallback(() => {
    const box = scroller.current
    if (!box) return
    box.scrollTo(Math.max(0, box.scrollHeight - box.viewport.height))
  }, [])

  return { scroller, pinned, handleJumpToBottom }
}
