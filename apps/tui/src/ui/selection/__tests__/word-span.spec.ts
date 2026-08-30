import { describe, expect, it } from 'bun:test'

import { wordSpanAt } from '../word-span'

const ROW = 'alpha beta-gamma  delta.epsilon()'

const wordAt = (column: number): string | null => {
  const span = wordSpanAt({ row: ROW, column })
  return span === null ? null : ROW.slice(span.start, span.end)
}

describe('wordSpanAt', () => {
  it('takes the whole run of word cells under the pointer', () => {
    expect(wordAt(0)).toBe('alpha')
    expect(wordAt(4)).toBe('alpha')
  })

  it('keeps a hyphenated word whole, the way a compound reads', () => {
    expect(wordAt(8)).toBe('beta-gamma')
  })

  it('stops at a dot, so a sentence never drags its punctuation along', () => {
    expect(wordAt(18)).toBe('delta')
    expect(wordAt(24)).toBe('epsilon')
  })

  it('takes a run of marks when the pointer is on one', () => {
    expect(wordAt(23)).toBe('.')
    expect(wordAt(31)).toBe('()')
  })

  it('answers with nothing on whitespace and past the end', () => {
    expect(wordAt(5)).toBeNull()
    expect(wordAt(16)).toBeNull()
    expect(wordAt(ROW.length)).toBeNull()
  })
})
