import { describe, expect, it } from 'bun:test'
import { DEFAULT_WARN_PERCENT, EMeterBand, EUsageWindow, type AccountUsage } from '@dltech/atlas-core'

import { EFooterMeters, footerMetersOf, usageMeters } from '../usage-meters'

const NOW = Date.parse('2026-08-29T12:00:00.000Z')

const inMinutes = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString()

const usage = (args: {
  fiveHour?: { utilization: number; resetsAt?: string | null }
  sevenDay?: { utilization: number; resetsAt?: string | null }
}): AccountUsage => ({
  [EUsageWindow.FiveHour]:
    args.fiveHour === undefined
      ? null
      : { utilization: args.fiveHour.utilization, resetsAt: args.fiveHour.resetsAt ?? null },
  [EUsageWindow.SevenDay]:
    args.sevenDay === undefined
      ? null
      : { utilization: args.sevenDay.utilization, resetsAt: args.sevenDay.resetsAt ?? null },
})

const metersOf = (args: {
  usage: AccountUsage
  show?: EFooterMeters
  warn?: Record<EUsageWindow, number>
}) =>
  usageMeters({
    usage: args.usage,
    show: args.show ?? EFooterMeters.All,
    warn: args.warn ?? DEFAULT_WARN_PERCENT,
    now: NOW,
  })

describe('usageMeters', () => {
  it('reads both windows as labelled percentages', () => {
    expect(metersOf({ usage: usage({ fiveHour: { utilization: 34 }, sevenDay: { utilization: 61 } }) })).toEqual([
      { label: '5h', band: EMeterBand.Normal, text: '34%' },
      { label: 'wk', band: EMeterBand.Normal, text: '61%' },
    ])
  })

  it('says nothing about a window it has not polled rather than reporting it idle', () => {
    expect(metersOf({ usage: usage({}) })).toEqual([
      { label: '5h', band: EMeterBand.Unknown, text: '—' },
      { label: 'wk', band: EMeterBand.Unknown, text: '—' },
    ])
  })

  it('replaces the figure with the wait once a window is spent', () => {
    const meters = metersOf({
      usage: usage({ fiveHour: { utilization: 100, resetsAt: inMinutes(134) } }),
    })
    expect(meters[0]).toEqual({ label: '5h', band: EMeterBand.Spent, text: '2h14m' })
  })

  it('says a spent window is full when it will not say when it refills', () => {
    const meters = metersOf({ usage: usage({ fiveHour: { utilization: 100 } }) })
    expect(meters[0]).toEqual({ label: '5h', band: EMeterBand.Spent, text: 'full' })
  })

  it('colours each window against its own threshold', () => {
    const both = usage({ fiveHour: { utilization: 66 }, sevenDay: { utilization: 66 } })
    expect(metersOf({ usage: both }).map((meter) => meter.band)).toEqual([
      EMeterBand.Warn,
      EMeterBand.Normal,
    ])
  })

  it('follows the thresholds it is given rather than the shipped ones', () => {
    const meters = metersOf({
      usage: usage({ fiveHour: { utilization: 40 } }),
      warn: { [EUsageWindow.FiveHour]: 30, [EUsageWindow.SevenDay]: 70 },
    })
    expect(meters[0]?.band).toBe(EMeterBand.Warn)
  })

  it('drops the weekly window, then both, as the operator asks for less', () => {
    const both = usage({ fiveHour: { utilization: 34 }, sevenDay: { utilization: 61 } })
    expect(metersOf({ usage: both, show: EFooterMeters.Session }).map((meter) => meter.label)).toEqual(['5h'])
    expect(metersOf({ usage: both, show: EFooterMeters.Context })).toEqual([])
  })
})

describe('footerMetersOf', () => {
  it('reads every shipped choice', () => {
    expect(footerMetersOf('all')).toBe(EFooterMeters.All)
    expect(footerMetersOf('session')).toBe(EFooterMeters.Session)
    expect(footerMetersOf('context')).toBe(EFooterMeters.Context)
  })

  it('falls back to showing everything when the value is not one it knows', () => {
    expect(footerMetersOf('nonsense')).toBe(EFooterMeters.All)
  })
})
