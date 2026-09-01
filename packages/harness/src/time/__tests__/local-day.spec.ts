import { describe, expect, it } from 'bun:test'

import { localDayOf, localWeekdayOf } from '../local-day'

const calendarDay = (instant: string): string =>
  new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(instant),
  )

describe('localDayOf', () => {
  it('agrees with the platform calendar for an instant inside the day', () => {
    const instant = '2026-09-01T18:00:00.000Z'

    expect(localDayOf(instant)).toBe(calendarDay(instant))
  })

  it('agrees with the platform calendar across a UTC midnight, where a slice would not', () => {
    const instant = '2026-09-02T02:00:00.000Z'

    expect(localDayOf(instant)).toBe(calendarDay(instant))
  })

  it('pads a single-digit month and day', () => {
    expect(localDayOf('2026-01-05T12:00:00.000Z')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('says nothing rather than inventing a date for an unusable instant', () => {
    expect(localDayOf('not a date')).toBe('')
    expect(localWeekdayOf('not a date')).toBe('')
  })
})

describe('localWeekdayOf', () => {
  it('names the day, so a memory can turn "Thursday" into a date', () => {
    expect(localWeekdayOf('2026-09-01T18:00:00.000Z')).toMatch(
      /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/,
    )
  })
})
