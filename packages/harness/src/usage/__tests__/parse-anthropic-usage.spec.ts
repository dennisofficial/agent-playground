import { describe, expect, it } from 'bun:test'
import { EUsageWindow } from '@dltech/atlas-core'

import { parseAnthropicUsage } from '../parse-anthropic-usage'

const LIVE_SHAPE = {
  five_hour: { utilization: 20.0, resets_at: '2026-08-02T19:30:00.764178+00:00' },
  seven_day: { utilization: 7.0, resets_at: '2026-08-05T10:00:00.764198+00:00' },
  seven_day_oauth_apps: null,
  seven_day_opus: null,
  seven_day_sonnet: null,
  extra_usage: { is_enabled: false, utilization: null },
}

describe('parseAnthropicUsage', () => {
  it('reads both windows off a real response', () => {
    expect(parseAnthropicUsage(LIVE_SHAPE)).toEqual({
      [EUsageWindow.FiveHour]: {
        utilization: 20,
        resetsAt: '2026-08-02T19:30:00.764178+00:00',
      },
      [EUsageWindow.SevenDay]: {
        utilization: 7,
        resetsAt: '2026-08-05T10:00:00.764198+00:00',
      },
    })
  })

  it('collapses the per-model weekly windows onto the one closest to stopping the work', () => {
    const parsed = parseAnthropicUsage({
      ...LIVE_SHAPE,
      seven_day: { utilization: 7, resets_at: null },
      seven_day_opus: { utilization: 61, resets_at: null },
      seven_day_sonnet: { utilization: 22, resets_at: null },
    })
    expect(parsed[EUsageWindow.SevenDay]?.utilization).toBe(61)
  })

  it('takes the endpoint at its word rather than rescaling a genuine 1%', () => {
    const parsed = parseAnthropicUsage({ five_hour: { utilization: 1, resets_at: null } })
    expect(parsed[EUsageWindow.FiveHour]?.utilization).toBe(1)
  })

  it('clamps a window to the range a meter can draw', () => {
    const parsed = parseAnthropicUsage({
      five_hour: { utilization: 140, resets_at: null },
      seven_day: { utilization: -3, resets_at: null },
    })
    expect(parsed[EUsageWindow.FiveHour]?.utilization).toBe(100)
    expect(parsed[EUsageWindow.SevenDay]?.utilization).toBe(0)
  })

  it('reports a missing window as never polled rather than as idle', () => {
    expect(parseAnthropicUsage({})).toEqual({
      [EUsageWindow.FiveHour]: null,
      [EUsageWindow.SevenDay]: null,
    })
    expect(parseAnthropicUsage({ five_hour: { resets_at: null } })[EUsageWindow.FiveHour]).toBeNull()
  })

  it('survives a body that is not the shape it expects', () => {
    for (const body of [null, undefined, 'nope', 42, []]) {
      expect(parseAnthropicUsage(body)).toEqual({
        [EUsageWindow.FiveHour]: null,
        [EUsageWindow.SevenDay]: null,
      })
    }
  })
})
