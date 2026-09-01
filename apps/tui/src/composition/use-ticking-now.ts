import { useEffect, useState } from 'react'

const TICK_MS = 1000

/**
 * A reading that nothing announces has to be taken rather than awaited: an elapsed time counts up
 * on its own, and a grace window elapses without anything changing. The interval exists only while
 * the caller says something is still moving, and stops the moment the last of it settles.
 */
export function useTickingNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!ticking) return

    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [ticking])

  return now
}
