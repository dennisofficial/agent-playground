import { describe, expect, it } from 'bun:test'

import { collapseUnchanged } from '../collapse'
import { EDiffLine, type DiffHunk, type DiffLine } from '../hunk'

const context = (number: number): DiffLine => ({
  kind: EDiffLine.Context,
  oldNumber: number,
  newNumber: number,
  text: `line ${number}`,
})

const added: DiffLine = { kind: EDiffLine.Added, oldNumber: null, newNumber: 99, text: 'added' }

const hunkOf = (lines: readonly DiffLine[]): DiffHunk => ({
  heading: 'function render() {',
  oldStart: 4,
  newStart: 6,
  lines,
})

const run = (from: number, count: number): DiffLine[] =>
  Array.from({ length: count }, (_unused, index) => context(from + index))

const shape = (hunk: DiffHunk) => hunk.lines.map((line) => line.elided ?? line.kind)

describe('collapseUnchanged', () => {
  it('leaves a run short enough to show untouched', () => {
    const hunk = hunkOf([...run(1, 4), added])

    expect(collapseUnchanged({ hunk, context: 2 }).lines).toEqual(hunk.lines)
  })

  it('leaves a run of exactly twice the context untouched', () => {
    const hunk = hunkOf([...run(1, 6), added])

    expect(collapseUnchanged({ hunk, context: 3 }).lines).toHaveLength(7)
  })

  it('elides the middle of a long run and counts what it dropped', () => {
    const hunk = hunkOf([added, ...run(1, 13), added])
    const collapsed = collapseUnchanged({ hunk, context: 2 })

    expect(shape(collapsed)).toEqual([
      EDiffLine.Added,
      EDiffLine.Context,
      EDiffLine.Context,
      9,
      EDiffLine.Context,
      EDiffLine.Context,
      EDiffLine.Added,
    ])
    expect(collapsed.lines[3]).toEqual({
      kind: EDiffLine.Elision,
      oldNumber: null,
      newNumber: null,
      text: '',
      elided: 9,
    })
  })

  it('collapses a run that opens the hunk', () => {
    const collapsed = collapseUnchanged({ hunk: hunkOf([...run(1, 10), added]), context: 1 })

    expect(shape(collapsed)).toEqual([EDiffLine.Context, 8, EDiffLine.Context, EDiffLine.Added])
  })

  it('collapses a run that closes the hunk', () => {
    const collapsed = collapseUnchanged({ hunk: hunkOf([added, ...run(1, 10)]), context: 1 })

    expect(shape(collapsed)).toEqual([EDiffLine.Added, EDiffLine.Context, 8, EDiffLine.Context])
  })

  it('collapses every run when no context is asked for', () => {
    const collapsed = collapseUnchanged({
      hunk: hunkOf([...run(1, 3), added, ...run(4, 5)]),
      context: 0,
    })

    expect(shape(collapsed)).toEqual([3, EDiffLine.Added, 5])
  })

  it('keeps the hunk heading and both start lines', () => {
    const collapsed = collapseUnchanged({ hunk: hunkOf(run(1, 20)), context: 2 })

    expect(collapsed.heading).toBe('function render() {')
    expect(collapsed.oldStart).toBe(4)
    expect(collapsed.newStart).toBe(6)
  })

  it('collapses each run of a hunk with several of them', () => {
    const collapsed = collapseUnchanged({
      hunk: hunkOf([...run(1, 9), added, ...run(10, 9)]),
      context: 1,
    })

    expect(shape(collapsed)).toEqual([
      EDiffLine.Context,
      7,
      EDiffLine.Context,
      EDiffLine.Added,
      EDiffLine.Context,
      7,
      EDiffLine.Context,
    ])
  })
})
