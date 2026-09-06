import { EMeterBand, type EUsageWindow } from '@dltech/atlas-core'
import type { AccountUsageService } from '@dltech/atlas-harness'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import { usageMeters, type EFooterMeters, type FooterMeter } from '../ui/usage-meters'

const MINUTE_MS = 60_000

const MINUTE_POLL_MS = 15_000

const NO_METERS: readonly FooterMeter[] = Object.freeze([])

const minuteOf = (now: number): number => Math.floor(now / MINUTE_MS)

/**
 * The meters read the clock only for a countdown, and a countdown is written to the minute, so the
 * clock they are keyed on is the minute rather than the render: a fresh `Date.now()` per render
 * gave every render a fresh readout and pulled the whole footer ladder along with it. The minute
 * advances only while a countdown is showing, so an idle footer costs no commits at all.
 */
export function useUsageMeters(args: {
  usage: AccountUsageService
  metered: boolean
  show: EFooterMeters
  warn: Record<EUsageWindow, number>
}): readonly FooterMeter[] {
  const { usage, metered, show, warn } = args
  const version = useSyncExternalStore(usage.subscribe, usage.version)
  const [minute, setMinute] = useState(() => minuteOf(Date.now()))
  const held = useRef(minute)

  const meters = useMemo(
    () =>
      metered ? usageMeters({ usage: usage.snapshot(), show, warn, now: Date.now() }) : NO_METERS,
    [metered, minute, show, usage, version, warn],
  )

  const countingDown = meters.some((meter) => meter.band === EMeterBand.Spent)

  useEffect(() => {
    if (!countingDown) return

    const timer = setInterval(() => {
      const next = minuteOf(Date.now())
      if (next === held.current) return

      held.current = next
      setMinute(next)
    }, MINUTE_POLL_MS)
    return () => clearInterval(timer)
  }, [countingDown])

  return meters
}
