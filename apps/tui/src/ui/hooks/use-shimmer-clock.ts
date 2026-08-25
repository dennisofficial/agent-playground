import { useEffect, useState } from 'react'

const SHIMMER_FRAME_MS = 40

export function useShimmerClock(args: { active: boolean; intervalMs?: number }): number {
  const { active } = args
  const intervalMs = args.intervalMs ?? SHIMMER_FRAME_MS
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [active, intervalMs])

  return now
}
