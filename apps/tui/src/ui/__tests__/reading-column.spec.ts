import { describe, expect, it } from 'bun:test'

import { READING_COLUMN, readingColumn } from '../reading-column'

describe('the reading column', () => {
  it('takes the terminal when the terminal is narrower than the column', () => {
    expect(readingColumn(60)).toBe(60)
  })

  it('caps at the column on a wide terminal rather than following it out', () => {
    expect(readingColumn(400)).toBe(READING_COLUMN)
  })

  it('is the terminal exactly at the boundary', () => {
    expect(readingColumn(READING_COLUMN)).toBe(READING_COLUMN)
  })

  it('never returns a width nothing can be drawn in', () => {
    expect(readingColumn(0)).toBeGreaterThan(0)
    expect(readingColumn(-10)).toBeGreaterThan(0)
  })

  it('is monotonic in the terminal width, so a resize never narrows the column', () => {
    for (let width = 1; width < 300; width += 1) {
      expect(readingColumn(width + 1)).toBeGreaterThanOrEqual(readingColumn(width))
    }
  })
})
