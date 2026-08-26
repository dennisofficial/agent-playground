import { describe, expect, it } from 'bun:test'

import { tail, thinkingSummary, wrapWords } from '../text-flow'

describe('wrapping prose', () => {
  it('breaks on words and never past the band', () => {
    const rows = wrapWords({ text: 'the quick brown fox jumped over the lazy dog', width: 12 })
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(12)
    expect(rows.join(' ')).toBe('the quick brown fox jumped over the lazy dog')
  })

  it('hard-splits a word wider than the band rather than clipping it', () => {
    const rows = wrapWords({
      text: '/Users/dennis/Developer/atlas/apps/tui/src/ui/theme.ts',
      width: 16,
    })
    expect(rows.join('')).toBe('/Users/dennis/Developer/atlas/apps/tui/src/ui/theme.ts')
  })

  it('keeps a blank line as a blank row, because it is a paragraph break', () => {
    expect(wrapWords({ text: '', width: 40 })).toEqual([''])
  })

  it('gives up on a band too narrow to wrap in', () => {
    expect(wrapWords({ text: 'unwrappable', width: 4 })).toEqual(['unwr'])
  })
})

describe('tailing a stream', () => {
  it('keeps everything when it fits', () => {
    expect(tail({ items: ['a', 'b'], limit: 4 })).toEqual({
      shown: ['a', 'b'],
      hidden: 0,
      notice: null,
    })
  })

  it('keeps the newest rows and counts what fell off the top', () => {
    const view = tail({ items: ['a', 'b', 'c', 'd'], limit: 2 })
    expect(view.shown).toEqual(['c', 'd'])
    expect(view.hidden).toBe(2)
    expect(view.notice).toBe('… +2 lines above')
  })

  it('says line, singular, for one', () => {
    expect(tail({ items: ['a', 'b'], limit: 1 }).notice).toBe('… +1 line above')
  })
})

describe('summarising thinking', () => {
  it('sizes in estimated tokens', () => {
    expect(thinkingSummary('x'.repeat(4000))).toBe('Thinking… (~1.0K tokens)')
  })

  it('rounds a short block to ten rather than claiming precision', () => {
    expect(thinkingSummary('x'.repeat(84))).toBe('Thinking… (~20 tokens)')
  })

  it('says nothing about size when there is nothing there', () => {
    expect(thinkingSummary('   ')).toBe('Thinking…')
  })
})

