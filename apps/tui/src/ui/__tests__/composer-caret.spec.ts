import { describe, expect, it } from 'bun:test'

import { caretOnLastRow } from '../composer-caret'

const logical = (text: string, offset: number): boolean =>
  caretOnLastRow({ text, offset, rowEndOffset: null })

describe('caretOnLastRow, reading the logical line', () => {
  it('says yes on an empty draft — there is nowhere below to go', () => {
    expect(logical('', 0)).toBe(true)
  })

  it('says yes at the end of a one-line draft', () => {
    expect(logical('hello', 5)).toBe(true)
  })

  it('says yes mid-way through a one-line draft', () => {
    expect(logical('hello', 2)).toBe(true)
  })

  it('says no on the first of three lines', () => {
    expect(logical('one\ntwo\nthree', 1)).toBe(false)
  })

  it('says no on the second of three lines', () => {
    expect(logical('one\ntwo\nthree', 5)).toBe(false)
  })

  it('says yes on the last of three lines', () => {
    expect(logical('one\ntwo\nthree', 10)).toBe(true)
  })

  it('says yes on the empty line a trailing newline opens', () => {
    expect(logical('one\n', 4)).toBe(true)
  })

  it('says no on the line above that trailing newline', () => {
    expect(logical('one\n', 2)).toBe(false)
  })
})

describe('caretOnLastRow, reading the visual row', () => {
  const WRAPPED = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima'

  it('says no mid-way through a soft-wrapped paragraph with no newline after the caret', () => {
    expect(caretOnLastRow({ text: WRAPPED, offset: 3, rowEndOffset: 38 })).toBe(false)
  })

  it('says yes once the caret sits on the last visual row', () => {
    expect(caretOnLastRow({ text: WRAPPED, offset: 60, rowEndOffset: WRAPPED.length })).toBe(true)
  })

  it('trusts a row end past the text rather than arguing with the editor', () => {
    expect(caretOnLastRow({ text: WRAPPED, offset: 60, rowEndOffset: WRAPPED.length + 1 })).toBe(
      true,
    )
  })

  it('falls back to the logical reading when no row end was measured', () => {
    expect(caretOnLastRow({ text: 'one\ntwo', offset: 1, rowEndOffset: null })).toBe(false)
    expect(caretOnLastRow({ text: 'one\ntwo', offset: 5, rowEndOffset: null })).toBe(true)
  })
})
