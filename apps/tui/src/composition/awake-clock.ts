import { awakeAt, suspensionFrom, suspensionTicked, type Suspension } from './turn-progress'

export type AwakeClock = {
  read: () => number
  resume: () => void
  tick: (intervalMs: number) => void
}

/**
 * Elapsed time that does not count a suspended laptop. A turn started before the lid closed would
 * otherwise read as hours long the moment it opens.
 *
 * This owns its suspension rather than handing a ref to whoever ticks it, which is what keeps the
 * clock a leaf: compaction and the turn driver both stamp against `read`, and only the ticker calls
 * `resume` and `tick`. Nothing the clock depends on depends on the clock.
 */
export function createAwakeClock(now: () => number = Date.now): AwakeClock {
  let suspension: Suspension = suspensionFrom({ now: now() })

  return {
    read: () => awakeAt({ suspension, now: now() }),

    resume: () => {
      suspension = suspensionFrom({ now: now(), suspendedMs: suspension.suspendedMs })
    },

    tick: (intervalMs: number) => {
      suspension = suspensionTicked({ suspension, now: now(), intervalMs })
    },
  }
}
