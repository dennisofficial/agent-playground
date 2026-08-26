import { describe, expect, it } from 'bun:test'

import { EDiffLine, type DiffHunk, type DiffLine } from '../hunk'
import { sideBySideRows } from '../side-by-side'

const removed = (text: string): DiffLine => ({
  kind: EDiffLine.Removed,
  oldNumber: 1,
  newNumber: null,
  text,
})

const added = (text: string): DiffLine => ({
  kind: EDiffLine.Added,
  oldNumber: null,
  newNumber: 1,
  text,
})

const context = (text: string): DiffLine => ({
  kind: EDiffLine.Context,
  oldNumber: 1,
  newNumber: 1,
  text,
})

const elision: DiffLine = {
  kind: EDiffLine.Elision,
  oldNumber: null,
  newNumber: null,
  text: '',
  elided: 9,
}

const hunkOf = (lines: readonly DiffLine[]): DiffHunk => ({
  heading: '',
  oldStart: 1,
  newStart: 1,
  lines,
})

const texts = (hunk: DiffHunk) =>
  sideBySideRows(hunk).map((row) => [row.left?.text ?? null, row.right?.text ?? null])

describe('sideBySideRows', () => {
  it('puts a context line on both sides', () => {
    expect(texts(hunkOf([context('kept')]))).toEqual([['kept', 'kept']])
  })

  it('pairs a replacement index by index', () => {
    expect(texts(hunkOf([removed('a'), removed('b'), added('x'), added('y')]))).toEqual([
      ['a', 'x'],
      ['b', 'y'],
    ])
  })

  it('pads the right when more lines were removed than added', () => {
    expect(texts(hunkOf([removed('a'), removed('b'), removed('c'), added('x')]))).toEqual([
      ['a', 'x'],
      ['b', null],
      ['c', null],
    ])
  })

  it('pads the left when more lines were added than removed', () => {
    expect(texts(hunkOf([removed('a'), added('x'), added('y'), added('z')]))).toEqual([
      ['a', 'x'],
      [null, 'y'],
      [null, 'z'],
    ])
  })

  it('leaves the right empty for a removal with nothing after it', () => {
    expect(texts(hunkOf([context('top'), removed('a'), removed('b')]))).toEqual([
      ['top', 'top'],
      ['a', null],
      ['b', null],
    ])
  })

  it('leaves the left empty for an addition with nothing before it', () => {
    expect(texts(hunkOf([context('top'), added('x'), added('y')]))).toEqual([
      ['top', 'top'],
      [null, 'x'],
      [null, 'y'],
    ])
  })

  it('starts a fresh pair when a removal follows an addition', () => {
    expect(texts(hunkOf([removed('a'), added('x'), removed('b')]))).toEqual([
      ['a', 'x'],
      ['b', null],
    ])
  })

  it('puts an elision on both sides', () => {
    const rows = sideBySideRows(hunkOf([removed('a'), elision, added('x')]))

    expect(rows.map((row) => [row.left?.kind ?? null, row.right?.kind ?? null])).toEqual([
      [EDiffLine.Removed, null],
      [EDiffLine.Elision, EDiffLine.Elision],
      [null, EDiffLine.Added],
    ])
  })

  it('keeps the order the hunk gave it', () => {
    expect(
      texts(
        hunkOf([
          context('one'),
          removed('two'),
          added('dos'),
          context('three'),
          added('four'),
          context('five'),
        ]),
      ),
    ).toEqual([
      ['one', 'one'],
      ['two', 'dos'],
      ['three', 'three'],
      [null, 'four'],
      ['five', 'five'],
    ])
  })

  it('gives an empty hunk no rows', () => {
    expect(sideBySideRows(hunkOf([]))).toEqual([])
  })
})
