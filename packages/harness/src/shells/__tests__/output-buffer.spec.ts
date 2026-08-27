import { describe, expect, it } from 'bun:test'

import { createOutputBuffer } from '../output-buffer'

describe('reading a background shell incrementally', () => {
  it('hands back only what arrived since the last offset', () => {
    const buffer = createOutputBuffer({ retain: 100 })
    buffer.append('first\n')

    const one = buffer.since(0)
    expect(one.text).toBe('first\n')
    expect(one.nextOffset).toBe(6)

    buffer.append('second\n')

    const two = buffer.since(one.nextOffset)
    expect(two.text).toBe('second\n')
    expect(two.droppedCharacters).toBe(0)
  })

  it('returns nothing when nothing new arrived, so a re-read is not a duplicate', () => {
    const buffer = createOutputBuffer({ retain: 100 })
    buffer.append('only\n')

    const first = buffer.since(0)
    const again = buffer.since(first.nextOffset)

    expect(again.text).toBe('')
    expect(again.nextOffset).toBe(first.nextOffset)
  })

  it('counts every character ever written, not just the retained ones', () => {
    const buffer = createOutputBuffer({ retain: 4 })
    buffer.append('abcdefghij')

    expect(buffer.totalCharacters()).toBe(10)
  })

  it('reports how much fell out of the window rather than silently skipping it', () => {
    const buffer = createOutputBuffer({ retain: 4 })
    buffer.append('abcdefghij')

    const delta = buffer.since(0)

    expect(delta.text).toBe('ghij')
    expect(delta.droppedCharacters).toBe(6)
    expect(delta.nextOffset).toBe(10)
  })

  it('drops nothing when the reader keeps up with the window', () => {
    const buffer = createOutputBuffer({ retain: 4 })
    buffer.append('abcd')
    const first = buffer.since(0)
    buffer.append('efgh')

    const second = buffer.since(first.nextOffset)

    expect(second.text).toBe('efgh')
    expect(second.droppedCharacters).toBe(0)
  })

  it('clamps an offset past the end to the end, so a stale cursor cannot read backwards', () => {
    const buffer = createOutputBuffer({ retain: 100 })
    buffer.append('abc')

    const delta = buffer.since(99)

    expect(delta.text).toBe('')
    expect(delta.nextOffset).toBe(3)
    expect(delta.droppedCharacters).toBe(0)
  })

  it('clamps a negative offset to the start', () => {
    const buffer = createOutputBuffer({ retain: 100 })
    buffer.append('abc')

    expect(buffer.since(-5).text).toBe('abc')
  })

  it('ignores an empty append', () => {
    const buffer = createOutputBuffer({ retain: 100 })
    buffer.append('')

    expect(buffer.totalCharacters()).toBe(0)
    expect(buffer.since(0).text).toBe('')
  })

  it('keeps the newest characters in the tail, for the stall sniffer', () => {
    const buffer = createOutputBuffer({ retain: 100 })
    buffer.append('Password: ')

    expect(buffer.tail(10)).toBe('Password: ')
    expect(buffer.tail(4)).toBe('rd: ')
  })

  it('returns the whole window when the tail limit exceeds it', () => {
    const buffer = createOutputBuffer({ retain: 100 })
    buffer.append('short')

    expect(buffer.tail(500)).toBe('short')
  })
})
