import { afterEach, describe, expect, it } from 'bun:test'

import {
  applyBlockDensity,
  blockDensity,
  blockDensityOf,
  densityVersion,
  EBlockDensity,
  SHIPPED_DENSITY,
  subscribeDensity,
} from '../density-store'

afterEach(() => {
  applyBlockDensity(SHIPPED_DENSITY)
})

describe('applyBlockDensity', () => {
  it('ships comfort, so the padded reading is what a new install gets', () => {
    expect(SHIPPED_DENSITY).toBe(EBlockDensity.Comfort)
    expect(blockDensity()).toBe(EBlockDensity.Comfort)
  })

  it('bumps a numeric version, which is what useSyncExternalStore snapshots', () => {
    const before = densityVersion()
    applyBlockDensity(EBlockDensity.Compact)
    expect(densityVersion()).toBe(before + 1)
    expect(blockDensity()).toBe(EBlockDensity.Compact)
  })

  it('says nothing when the density is already the one asked for', () => {
    applyBlockDensity(EBlockDensity.Compact)
    let calls = 0
    const unsubscribe = subscribeDensity(() => {
      calls += 1
    })

    applyBlockDensity(EBlockDensity.Compact)
    unsubscribe()

    expect(calls).toBe(0)
  })

  it('stops calling a listener that unsubscribed', () => {
    let calls = 0
    const unsubscribe = subscribeDensity(() => {
      calls += 1
    })
    unsubscribe()

    applyBlockDensity(EBlockDensity.Compact)
    expect(calls).toBe(0)
  })
})

describe('blockDensityOf', () => {
  it('reads the two values the setting offers', () => {
    expect(blockDensityOf('compact')).toBe(EBlockDensity.Compact)
    expect(blockDensityOf('comfort')).toBe(EBlockDensity.Comfort)
  })

  it('falls back to comfort for anything a hand-edited settings file might hold', () => {
    expect(blockDensityOf('roomy')).toBe(EBlockDensity.Comfort)
    expect(blockDensityOf('')).toBe(EBlockDensity.Comfort)
  })
})
