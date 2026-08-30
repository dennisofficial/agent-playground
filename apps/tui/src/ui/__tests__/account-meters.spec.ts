import { describe, expect, it } from 'bun:test'
import { DEFAULT_WARN_PERCENT, EUsageWindow, NO_USAGE, type AccountUsage } from '@dltech/atlas-core'

import { ACCOUNT_METER_CELLS, accountMeterSpans } from '../account-meters'

const NOW = Date.parse('2026-08-29T12:00:00.000Z')

const textOf = (usage: AccountUsage): string =>
  accountMeterSpans({ usage, warn: DEFAULT_WARN_PERCENT, now: NOW })
    .map((span) => span.text)
    .join('')

describe('accountMeterSpans', () => {
  it('draws both windows as a gauge and a figure', () => {
    expect(
      textOf({
        [EUsageWindow.FiveHour]: { utilization: 34, resetsAt: null },
        [EUsageWindow.SevenDay]: { utilization: 61, resetsAt: null },
      }),
    ).toBe('5h ▰▰▱▱▱ 34%  wk ▰▰▰▰▱ 61%')
  })

  it('leaves the gauge empty and says so when it has never polled', () => {
    expect(textOf(NO_USAGE)).toBe('5h ▱▱▱▱▱ —  wk ▱▱▱▱▱ —')
  })

  it('counts down instead of repeating the figure once a window will refill', () => {
    expect(
      textOf({
        [EUsageWindow.FiveHour]: {
          utilization: 100,
          resetsAt: new Date(NOW + 134 * 60_000).toISOString(),
        },
        [EUsageWindow.SevenDay]: null,
      }),
    ).toStartWith('5h ▰▰▰▰▰ 2h14m')
  })

  it('keeps every gauge the same width so the column does not ripple', () => {
    for (const utilization of [0, 1, 50, 99, 100]) {
      const spans = accountMeterSpans({
        usage: { [EUsageWindow.FiveHour]: { utilization, resetsAt: null }, [EUsageWindow.SevenDay]: null },
        warn: DEFAULT_WARN_PERCENT,
        now: NOW,
      })
      const gauge = (spans[1]?.text ?? '').length + (spans[2]?.text ?? '').length
      expect(gauge).toBe(ACCOUNT_METER_CELLS)
    }
  })
})
