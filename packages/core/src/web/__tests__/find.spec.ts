import { describe, expect, it } from 'bun:test'

import { findInPage, renderFound } from '../find'

const page = [
  'line one',
  'line two',
  'the needle is here',
  'line four',
  'line five',
  'line six',
  'line seven',
  'another needle',
  'line nine',
].join('\n')

describe('findInPage', () => {
  it('returns the matching line with its surroundings', () => {
    const outcome = findInPage({ body: page, pattern: 'needle is', context: 1 })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    expect(outcome.found.matched).toBe(1)
    expect(outcome.found.excerpt).toBe('line two\nthe needle is here\nline four')
  })

  it('separates passages that are far apart and merges ones that overlap', () => {
    const outcome = findInPage({ body: page, pattern: 'needle', context: 1 })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    expect(outcome.found.matched).toBe(2)
    expect(outcome.found.blocks).toBe(2)
    expect(outcome.found.excerpt).toContain('...')

    const wide = findInPage({ body: page, pattern: 'needle', context: 4 })
    expect(wide.ok).toBe(true)
    if (!wide.ok) return
    expect(wide.found.blocks).toBe(1)
    expect(wide.found.excerpt).not.toContain('...')
  })

  it('matches without regard to case', () => {
    const outcome = findInPage({ body: page, pattern: 'NEEDLE', context: 0 })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.found.matched).toBe(2)
  })

  it('finds nothing without pretending it failed', () => {
    const outcome = findInPage({ body: page, pattern: 'haystack', context: 2 })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.found.matched).toBe(0)
    expect(outcome.found.excerpt).toBe('')
  })

  it('says so when the pattern is not a regular expression', () => {
    const outcome = findInPage({ body: page, pattern: '(unclosed', context: 2 })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.reason).toContain('not a valid regular expression')
  })
})

describe('renderFound', () => {
  it('tells the model the page was read even when nothing matched', () => {
    const rendered = renderFound({
      found: { excerpt: '', matched: 0, shown: 0, blocks: 0 },
      pattern: 'x',
    })
    expect(rendered).toContain('was fetched')
    expect(rendered).toContain('without a pattern')
  })

  it('counts the matches and admits when passages were left out', () => {
    const rendered = renderFound({
      found: { excerpt: 'x', matched: 40, shown: 20, blocks: 33 },
      pattern: 'thing',
    })
    expect(rendered).toContain('40 lines match')
    expect(rendered).toContain('first 20 of 33 passages')
  })
})
