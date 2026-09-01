import { useEffect, useState } from 'react'

import type { AwakeClock } from './awake-clock'

const CLOCK_TICK_MS = 250

/**
 * The clock is read by anything that stamps a start; this only decides when it advances. Keeping
 * the two apart is what lets compaction stamp against a clock whose ticking depends on whether a
 * compaction is running.
 */
export function useTickingNow(args: { ticking: boolean; clock: AwakeClock }): number {
  const { ticking, clock } = args
  const [now, setNow] = useState(clock.read)

  useEffect(() => {
    if (!ticking) return

    clock.resume()
    setNow(clock.read())

    const timer = setInterval(() => {
      clock.tick(CLOCK_TICK_MS)
      setNow(clock.read())
    }, CLOCK_TICK_MS)
    return () => clearInterval(timer)
  }, [clock, ticking])

  return now
}
