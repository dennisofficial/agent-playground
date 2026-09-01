import { describe, expect, it } from 'bun:test'

import { createAwakeClock } from '../awake-clock'

const TICK = 250

function steppable(start: number): { now: () => number; advance: (by: number) => void } {
  let millis = start
  return {
    now: () => millis,
    advance: (by: number) => {
      millis += by
    },
  }
}

describe('the awake clock', () => {
  it('reads wall time while nothing is suspended', () => {
    const time = steppable(1_000)
    const clock = createAwakeClock(time.now)

    time.advance(500)

    expect(clock.read()).toBe(1_500)
  })

  it('counts an interval that arrived on time in full', () => {
    const time = steppable(1_000)
    const clock = createAwakeClock(time.now)

    time.advance(TICK)
    clock.tick(TICK)

    expect(clock.read()).toBe(1_250)
  })

  /**
   * The lid closing is indistinguishable from a very late interval, which is the point: both mean
   * nobody was watching, so neither should be billed to the turn.
   */
  it('does not count time the process spent suspended', () => {
    const time = steppable(1_000)
    const clock = createAwakeClock(time.now)

    time.advance(60_000)
    clock.tick(TICK)

    expect(clock.read()).toBe(1_250)
  })

  it('keeps discounting across several suspensions', () => {
    const time = steppable(0)
    const clock = createAwakeClock(time.now)

    time.advance(60_000)
    clock.tick(TICK)
    time.advance(60_000)
    clock.tick(TICK)

    expect(clock.read()).toBe(TICK * 2)
  })

  /**
   * A late interval is not a suspension. The floor is what keeps an ordinary scheduling hiccup, or
   * a busy event loop, from being written off as time nobody was watching.
   */
  it('counts a merely late interval as elapsed', () => {
    const time = steppable(0)
    const clock = createAwakeClock(time.now)

    time.advance(5_000)
    clock.tick(TICK)

    expect(clock.read()).toBe(5_000)
  })

  it('resuming keeps what was already discounted rather than starting over', () => {
    const time = steppable(0)
    const clock = createAwakeClock(time.now)

    time.advance(10_000)
    clock.tick(TICK)
    const discounted = clock.read()

    clock.resume()

    expect(clock.read()).toBe(discounted)
  })

  /**
   * What any caller actually asks the clock is how long something took, and that is a difference
   * between two readings — so an idle gap the clock never ticked through is allowed to move both
   * ends equally. Only intervals it did tick through are discounted.
   */
  it('measures a turn by the time it was awake, not the time on the wall', () => {
    const time = steppable(0)
    const clock = createAwakeClock(time.now)
    clock.resume()
    const startedAt = clock.read()

    time.advance(TICK)
    clock.tick(TICK)
    time.advance(60_000)
    clock.tick(TICK)
    time.advance(TICK)
    clock.tick(TICK)

    expect(clock.read() - startedAt).toBe(TICK * 3)
  })
})
