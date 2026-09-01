import { describe, expect, it } from 'bun:test'

import {
  ESidebarPlace,
  NO_SIDEBAR_SECTIONS,
  orderSections,
  sectionsAt,
  type SidebarSection,
} from '../sidebar-section'

const section = (args: { id: string; place: ESidebarPlace; rows?: number }): SidebarSection => ({
  id: args.id,
  place: args.place,
  rows: Array.from({ length: args.rows ?? 1 }, (unused, index) => ({
    id: `${args.id}-${index}`,
    spans: [{ text: args.id }],
  })),
})

describe('orderSections', () => {
  it('puts the facts above the panels whatever order they were contributed in', () => {
    const ordered = orderSections([
      section({ id: 'panel', place: ESidebarPlace.Panels }),
      section({ id: 'repo', place: ESidebarPlace.Facts }),
    ])

    expect(ordered.map((found) => found.id)).toEqual(['repo', 'panel'])
  })

  it('keeps contribution order among sections that share a place', () => {
    const ordered = orderSections([
      section({ id: 'second', place: ESidebarPlace.Facts }),
      section({ id: 'first', place: ESidebarPlace.Facts }),
    ])

    expect(ordered.map((found) => found.id)).toEqual(['second', 'first'])
  })

  it('drops a section with no rows rather than leaving a heading with nothing under it', () => {
    const ordered = orderSections([
      section({ id: 'empty', place: ESidebarPlace.Facts, rows: 0 }),
      section({ id: 'repo', place: ESidebarPlace.Facts }),
    ])

    expect(ordered.map((found) => found.id)).toEqual(['repo'])
  })

  it('answers the same empty list when nothing survives', () => {
    expect(orderSections([section({ id: 'empty', place: ESidebarPlace.Facts, rows: 0 })])).toBe(
      NO_SIDEBAR_SECTIONS,
    )
  })
})

describe('sectionsAt', () => {
  it('hands each anchor only what belongs to it', () => {
    const sections = [
      section({ id: 'repo', place: ESidebarPlace.Facts }),
      section({ id: 'panel', place: ESidebarPlace.Panels }),
    ]

    expect(sectionsAt({ sections, place: ESidebarPlace.Panels }).map((found) => found.id)).toEqual([
      'panel',
    ])
  })
})
