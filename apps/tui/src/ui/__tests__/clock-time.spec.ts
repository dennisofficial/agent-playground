import { describe, expect, it } from 'bun:test'

import { formatClockTime } from '../theme'

const localIso = (args: { hours: number; minutes: number }): string => {
  const at = new Date(2026, 7, 28, args.hours, args.minutes, 0, 0)
  return at.toISOString()
}

describe('the time a turn ended', () => {
  it('reads as a wall clock in the operator local time', () => {
    expect(formatClockTime(localIso({ hours: 18, minutes: 32 }))).toBe('6:32pm')
    expect(formatClockTime(localIso({ hours: 6, minutes: 32 }))).toBe('6:32am')
  })

  it('pads the minute so the column does not jump', () => {
    expect(formatClockTime(localIso({ hours: 9, minutes: 5 }))).toBe('9:05am')
  })

  it('calls both ends of the day twelve, never zero', () => {
    expect(formatClockTime(localIso({ hours: 0, minutes: 15 }))).toBe('12:15am')
    expect(formatClockTime(localIso({ hours: 12, minutes: 15 }))).toBe('12:15pm')
  })

  it('says nothing rather than NaN when the stamp is unreadable', () => {
    expect(formatClockTime('not a timestamp')).toBe('')
  })
})
