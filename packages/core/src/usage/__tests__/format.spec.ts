import { describe, expect, it } from 'bun:test'

import { formatCountdown, formatUtilization } from '../format'

const NOW = Date.parse('2026-08-29T12:00:00.000Z')

const inMinutes = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString()

describe('formatCountdown', () => {
  it('spells hours and minutes once the wait passes an hour', () => {
    expect(formatCountdown({ resetsAt: inMinutes(134), now: NOW })).toBe('2h14m')
  })

  it('pads the minutes so the width does not jitter as it counts down', () => {
    expect(formatCountdown({ resetsAt: inMinutes(127), now: NOW })).toBe('2h07m')
  })

  it('drops the hours entirely under an hour', () => {
    expect(formatCountdown({ resetsAt: inMinutes(41), now: NOW })).toBe('41m')
  })

  it('says now rather than counting backwards once the reset has passed', () => {
    expect(formatCountdown({ resetsAt: inMinutes(-5), now: NOW })).toBe('now')
  })

  it('says nothing at all when there is no reset to wait for', () => {
    expect(formatCountdown({ resetsAt: null, now: NOW })).toBe('')
    expect(formatCountdown({ resetsAt: 'not a date', now: NOW })).toBe('')
  })
})

describe('formatUtilization', () => {
  it('reads a polled window as a percentage', () => {
    expect(formatUtilization(34)).toBe('34%')
  })

  it('distinguishes never polled from idle', () => {
    expect(formatUtilization(null)).toBe('—')
    expect(formatUtilization(0)).toBe('0%')
  })
})
