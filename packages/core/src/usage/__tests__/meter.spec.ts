import { describe, expect, it } from 'bun:test'

import {
  DEFAULT_WARN_PERCENT,
  EMeterBand,
  isPressured,
  meterBand,
  meterFill,
  meterThresholds,
} from '../meter'
import { EUsageWindow } from '../window'

const bandAt = (args: { utilization: number | null; warnAt?: number }): EMeterBand =>
  meterBand({
    utilization: args.utilization,
    warnAt: args.warnAt ?? DEFAULT_WARN_PERCENT[EUsageWindow.FiveHour],
  })

describe('meterThresholds', () => {
  it('spaces hot and red across the headroom the warning leaves', () => {
    expect(meterThresholds(65)).toEqual({ warn: 65, hot: 82, red: 93 })
    expect(meterThresholds(70)).toEqual({ warn: 70, hot: 85, red: 94 })
  })

  it('keeps every threshold ordered and inside the window for any warning', () => {
    for (let warn = 0; warn <= 100; warn += 1) {
      const { hot, red } = meterThresholds(warn)
      expect(warn).toBeLessThanOrEqual(hot)
      expect(hot).toBeLessThanOrEqual(red)
      expect(red).toBeLessThanOrEqual(100)
    }
  })
})

describe('meterBand', () => {
  it('reads an unpolled window as unknown rather than idle', () => {
    expect(bandAt({ utilization: null })).toBe(EMeterBand.Unknown)
  })

  it('climbs through the bands as the window fills', () => {
    expect(bandAt({ utilization: 12 })).toBe(EMeterBand.Normal)
    expect(bandAt({ utilization: 65 })).toBe(EMeterBand.Warn)
    expect(bandAt({ utilization: 82 })).toBe(EMeterBand.Hot)
    expect(bandAt({ utilization: 93 })).toBe(EMeterBand.Red)
  })

  it('calls a full window spent, because a countdown is all it has left to say', () => {
    expect(bandAt({ utilization: 100 })).toBe(EMeterBand.Spent)
    expect(bandAt({ utilization: 140 })).toBe(EMeterBand.Spent)
  })

  it('moves every band when the warning moves', () => {
    expect(bandAt({ utilization: 50, warnAt: 40 })).toBe(EMeterBand.Warn)
    expect(bandAt({ utilization: 50, warnAt: 90 })).toBe(EMeterBand.Normal)
  })

  it('warns later on the weekly window than the session one', () => {
    expect(DEFAULT_WARN_PERCENT[EUsageWindow.SevenDay]).toBeGreaterThan(
      DEFAULT_WARN_PERCENT[EUsageWindow.FiveHour],
    )
  })
})

describe('isPressured', () => {
  it('is true for every band above normal', () => {
    expect([EMeterBand.Warn, EMeterBand.Hot, EMeterBand.Red, EMeterBand.Spent].map(isPressured))
      .toEqual([true, true, true, true])
  })

  it('is false where there is nothing to say', () => {
    expect([EMeterBand.Normal, EMeterBand.Unknown].map(isPressured)).toEqual([false, false])
  })
})

describe('meterFill', () => {
  it('shows a cell the moment a window is touched at all', () => {
    expect(meterFill({ utilization: 1, cells: 5 })).toBe(1)
  })

  it('leaves the gauge empty when there is nothing to draw', () => {
    expect(meterFill({ utilization: null, cells: 5 })).toBe(0)
    expect(meterFill({ utilization: 0, cells: 5 })).toBe(0)
  })

  it('never draws past the gauge', () => {
    expect(meterFill({ utilization: 100, cells: 5 })).toBe(5)
    expect(meterFill({ utilization: 140, cells: 5 })).toBe(5)
  })
})
