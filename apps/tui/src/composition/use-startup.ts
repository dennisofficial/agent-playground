import { useRenderer } from '@opentui/react'
import { useCallback, useEffect, useState } from 'react'

import { startupFrame, startupIsOver, type StartupFrame } from '../ui/startup-model'

const STARTUP_FRAME_MS = 16

export type StartupControl = {
  frame: StartupFrame
  covered: boolean
  handleSkip: () => void
}

/**
 * The ink is timed from the first frame the renderer actually paints, not from the mount that asked
 * for it: everything between the two — the harness settling, the workspace's first layout, a
 * terminal still answering the palette query — would otherwise be spent sweeping a screen nobody
 * can see yet, and the operator would meet the wordmark half drawn.
 */
export function useStartup(args: { ready: boolean }): StartupControl {
  const renderer = useRenderer()
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [readyAtMs, setReadyAtMs] = useState<number | null>(null)
  const [skippedAtMs, setSkippedAtMs] = useState<number | null>(null)

  useEffect(() => {
    const onFrame = (): void => setStartedAt((current) => current ?? Date.now())

    renderer.on('frame', onFrame)
    return () => void renderer.off('frame', onFrame)
  }, [renderer])

  const sinceStart = useCallback(
    () => (startedAt === null ? 0 : Date.now() - startedAt),
    [startedAt],
  )

  useEffect(() => {
    if (!args.ready) return
    setReadyAtMs((current) => current ?? sinceStart())
  }, [args.ready, sinceStart])

  const frame = startupFrame({
    elapsedMs: startedAt === null ? 0 : now - startedAt,
    readyAtMs,
    skippedAtMs,
  })
  const over = startupIsOver(frame)

  useEffect(() => {
    if (over) return

    const timer = setInterval(() => setNow(Date.now()), STARTUP_FRAME_MS)
    return () => clearInterval(timer)
  }, [over])

  const handleSkip = useCallback(() => {
    setSkippedAtMs((current) => current ?? sinceStart())
  }, [sinceStart])

  return { frame, covered: !over, handleSkip }
}
