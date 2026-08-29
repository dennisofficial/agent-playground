import type { ScrollBoxRenderable } from '@opentui/core'
import { useCallback, useEffect, useRef, useState } from 'react'

import { isPinnedToBottom } from '../scroll-position'
import { useProportionalThumb } from '../scrollbar-thumb'
import { EOutputScroll, type OutputScrollCommand } from '../shells-model'

/**
 * OpenTUI's scrollbox emits no scroll event, and the wheel, a drag and sticky-scroll chasing new
 * output all move it without passing through React — so where the log is sitting is polled.
 */
const POLL_MS = 250

export type OutputScroll = {
  attach: (box: ScrollBoxRenderable | null) => void
  pinned: boolean
  handleJumpToEnd: () => void
  handleCommand: (command: OutputScrollCommand) => void
}

const restingAtEnd = (box: ScrollBoxRenderable): boolean =>
  isPinnedToBottom({
    scrollTop: box.scrollTop,
    scrollHeight: box.scrollHeight,
    viewportHeight: box.viewport.height,
  })

export function useOutputScroll(args: { resetKey?: string | undefined } = {}): OutputScroll {
  const scroller = useRef<ScrollBoxRenderable | null>(null)
  const attach = useProportionalThumb(scroller)
  const [pinned, setPinned] = useState(true)
  const resetKey = args.resetKey

  useEffect(() => {
    const timer = setInterval(() => {
      const box = scroller.current
      if (!box) return
      setPinned(restingAtEnd(box))
    }, POLL_MS)

    return () => clearInterval(timer)
  }, [])

  const handleJumpToEnd = useCallback(() => {
    const box = scroller.current
    if (!box) return

    box.scrollTo(Math.max(0, box.scrollHeight - box.viewport.height))
    setPinned(true)
  }, [])

  const handleCommand = useCallback(
    (command: OutputScrollCommand) => {
      const box = scroller.current
      if (!box) return

      if (command.kind === EOutputScroll.ToEnd) {
        handleJumpToEnd()
        return
      }

      if (command.kind === EOutputScroll.ToStart) box.scrollTo(0)
      else if (command.kind === EOutputScroll.Pages) box.scrollBy(command.amount, 'viewport')
      else box.scrollBy(command.amount)

      setPinned(restingAtEnd(box))
    },
    [handleJumpToEnd],
  )

  /**
   * Sticky scroll pauses the moment a reader scrolls up, and it is the shell being read that the
   * pause belongs to: another shell's log opens at its end.
   */
  useEffect(() => {
    if (resetKey === undefined) return
    handleJumpToEnd()
  }, [resetKey, handleJumpToEnd])

  return { attach, pinned, handleJumpToEnd, handleCommand }
}
