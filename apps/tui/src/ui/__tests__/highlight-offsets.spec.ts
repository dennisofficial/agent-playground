import { describe, expect, it } from 'bun:test'

import { charRangeOf } from '../highlight-offsets'

describe('charRangeOf', () => {
  it('leaves a span on the first line where it is', () => {
    expect(charRangeOf({ text: 'why is @a.ts broken', span: { start: 7, end: 12 } })).toEqual({
      start: 7,
      end: 12,
    })
  })

  it('pulls a span back by every line break before it', () => {
    const text = 'one\ntwo\n@a.ts'
    const start = text.indexOf('@')

    expect(charRangeOf({ text, span: { start, end: start + 5 } })).toEqual({
      start: start - 2,
      end: start + 3,
    })
  })

  it('pulls the end back for a break inside the span as well', () => {
    const text = 'a\nbc'
    expect(charRangeOf({ text, span: { start: 0, end: 4 } })).toEqual({ start: 0, end: 3 })
  })

  it('is unbothered by a span reaching past the end of the text', () => {
    expect(charRangeOf({ text: 'ab', span: { start: 0, end: 9 } })).toEqual({ start: 0, end: 9 })
  })
})
