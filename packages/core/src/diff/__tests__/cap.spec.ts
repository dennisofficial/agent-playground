import { describe, expect, it } from 'bun:test'

import { capHunks } from '../cap'
import { EDiffLine, type DiffHunk, type DiffLine } from '../hunk'

const added = (number: number): DiffLine => ({
  kind: EDiffLine.Added,
  oldNumber: null,
  newNumber: number,
  text: `line ${number}`,
})

const hunkOf = (count: number, from = 1): DiffHunk => ({
  heading: 'function render() {',
  oldStart: 0,
  newStart: from,
  lines: Array.from({ length: count }, (_unused, index) => added(from + index)),
})

describe('capHunks', () => {
  it('returns the same hunks when the diff fits the cap', () => {
    const hunks = [hunkOf(10), hunkOf(20, 100)]

    expect(capHunks({ hunks, cap: 30 })).toBe(hunks)
    expect(capHunks({ hunks, cap: 500 })).toBe(hunks)
  })

  it('keeps cap minus one lines and books the rest as one overflow row', () => {
    const capped = capHunks({ hunks: [hunkOf(12_227)], cap: 200 })

    expect(capped).toHaveLength(1)
    expect(capped[0]?.lines).toHaveLength(200)
    expect(capped[0]?.lines.at(-1)).toEqual({
      kind: EDiffLine.Elision,
      oldNumber: null,
      newNumber: null,
      text: '',
      elided: 12_028,
      overflow: true,
    })
  })

  it('spends the cap across hunks and drops the ones it cannot reach', () => {
    const capped = capHunks({ hunks: [hunkOf(150), hunkOf(150, 500), hunkOf(50, 900)], cap: 200 })

    expect(capped).toHaveLength(2)
    expect(capped[0]?.lines).toHaveLength(150)
    expect(capped[1]?.lines).toHaveLength(50)
    expect(capped[1]?.lines.at(-1)).toMatchObject({ elided: 151, overflow: true })
  })

  it('marks the overflow row apart from an unchanged-lines elision', () => {
    const capped = capHunks({ hunks: [hunkOf(10)], cap: 5 })
    const overflow = capped[0]?.lines.at(-1)

    expect(overflow?.kind).toBe(EDiffLine.Elision)
    expect(overflow?.overflow).toBe(true)
  })
})
