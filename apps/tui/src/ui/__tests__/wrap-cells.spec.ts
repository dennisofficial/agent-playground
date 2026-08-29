import { describe, expect, it } from 'bun:test'

import { wrapCells } from '../components/sidebar/cells'

const wrap = (text: string, cells: number): string[] => wrapCells({ text, cells })

describe('soft-wrapping a label into the cells it has', () => {
  it('leaves a label that already fits on one line', () => {
    expect(wrap('Ship it', 20)).toEqual(['Ship it'])
  })

  it('breaks on a space rather than mid-word', () => {
    expect(wrap('Soft-wrap the sidebar text', 12)).toEqual(['Soft-wrap', 'the sidebar', 'text'])
  })

  it('fills each line as far as it goes', () => {
    expect(wrap('a b c d e f', 5)).toEqual(['a b c', 'd e f'])
  })

  it('never emits a line wider than the cells it was given', () => {
    const lines = wrap('Fix the threads reference in guarded-fork so turbo goes green', 14)

    for (const line of lines) expect(line.length).toBeLessThanOrEqual(14)
  })

  it('hard-breaks a single word too long to fit', () => {
    expect(wrap('packages/harness/src/store/guarded-fork.ts', 10)).toEqual([
      'packages/h',
      'arness/src',
      '/store/gua',
      'rded-fork.',
      'ts',
    ])
  })

  it('keeps wrapping the words after a hard-broken one, onto its remainder', () => {
    expect(wrap('aaaaaa bb', 5)).toEqual(['aaaaa', 'a bb'])
  })

  it('collapses the whitespace it wraps on', () => {
    expect(wrap('one   two', 20)).toEqual(['one two'])
  })

  it('has nothing to say about an empty label', () => {
    expect(wrap('', 10)).toEqual([])
    expect(wrap('   ', 10)).toEqual([])
  })

  it('refuses to wrap into no room at all, rather than looping', () => {
    expect(wrap('anything', 0)).toEqual([])
    expect(wrap('anything', -1)).toEqual([])
  })
})
