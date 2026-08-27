import { describe, expect, it } from 'bun:test'

import { queuedLine } from '../components/blocks/pending-block'

describe('a queued message shown as one row', () => {
  it('leaves a short message exactly as it was typed', () => {
    expect(queuedLine({ text: 'check the tests too', columns: 40 })).toBe('check the tests too')
  })

  it('flattens the newlines of a multi-line draft into one row', () => {
    expect(queuedLine({ text: 'check the tests\n\nand the fixtures', columns: 40 })).toBe(
      'check the tests and the fixtures',
    )
  })

  it('trims the edges rather than spending the row on whitespace', () => {
    expect(queuedLine({ text: '   padded   ', columns: 40 })).toBe('padded')
  })

  it('cuts an over-long message to the columns it was given, ellipsis included', () => {
    const line = queuedLine({ text: 'a'.repeat(60), columns: 10 })

    expect([...line].length).toBe(10)
    expect(line).toBe(`${'a'.repeat(9)}…`)
  })

  it('measures in characters, so an emoji does not overrun the row', () => {
    const line = queuedLine({ text: '🙂'.repeat(20), columns: 5 })

    expect([...line].length).toBe(5)
  })
})
