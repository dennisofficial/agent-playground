import { useCallback, useEffect, useRef, useState } from 'react'

import { startupFrame, startupIsOver, type StartupFrame } from '../ui/startup-model'

const STARTUP_FRAME_MS = 16

export type StartupControl = {
  frame: StartupFrame
  covered: boolean
  handleSkip: () => void
}

export function useStartup(args: { ready: boolean }): StartupControl {
  const startedAt = useRef(Date.now())
  const [now, setNow] = useState(() => Date.now())
  const [readyAtMs, setReadyAtMs] = useState<number | null>(null)
  const [skippedAtMs, setSkippedAtMs] = useState<number | null>(null)

  const sinceStart = useCallback(() => Date.now() - startedAt.current, [])

  useEffect(() => {
    if (!args.ready) return
    setReadyAtMs((current) => current ?? sinceStart())
  }, [args.ready, sinceStart])

  const frame = startupFrame({ elapsedMs: now - startedAt.current, readyAtMs, skippedAtMs })
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
