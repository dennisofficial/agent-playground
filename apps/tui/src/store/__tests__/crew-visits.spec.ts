import { describe, expect, it } from 'bun:test'

import { NO_VISITS, lastVisitOf, recordDeparture } from '../crew-visits'

const CHILD = 'thr_child'

const OTHER = 'thr_other'

const NOON = '2026-01-01T12:00:00.000Z'

const LATER = '2026-01-01T12:05:00.000Z'

describe('crew visits', () => {
  it('reads nothing for a child never viewed', () => {
    expect(lastVisitOf({ visits: NO_VISITS, id: CHILD })).toBeNull()
  })

  it('records when a child stopped being viewed', () => {
    const visits = recordDeparture({ visits: NO_VISITS, leaving: CHILD, at: NOON })

    expect(lastVisitOf({ visits, id: CHILD })).toBe(NOON)
  })

  it('leaves the held reading alone when nothing was being viewed', () => {
    const visits = recordDeparture({ visits: NO_VISITS, leaving: null, at: NOON })

    expect(visits).toBe(NO_VISITS)
  })

  it('moves a second departure forward', () => {
    const first = recordDeparture({ visits: NO_VISITS, leaving: CHILD, at: NOON })
    const second = recordDeparture({ visits: first, leaving: CHILD, at: LATER })

    expect(lastVisitOf({ visits: second, id: CHILD })).toBe(LATER)
  })

  it('keeps each child its own reading', () => {
    const first = recordDeparture({ visits: NO_VISITS, leaving: CHILD, at: NOON })
    const second = recordDeparture({ visits: first, leaving: OTHER, at: LATER })

    expect(lastVisitOf({ visits: second, id: CHILD })).toBe(NOON)
    expect(lastVisitOf({ visits: second, id: OTHER })).toBe(LATER)
  })

  it('does not mutate the reading it was given', () => {
    const first = recordDeparture({ visits: NO_VISITS, leaving: CHILD, at: NOON })
    recordDeparture({ visits: first, leaving: CHILD, at: LATER })

    expect(lastVisitOf({ visits: first, id: CHILD })).toBe(NOON)
  })
})
