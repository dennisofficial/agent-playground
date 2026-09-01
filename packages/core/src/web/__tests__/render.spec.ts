import { describe, expect, it } from 'bun:test'

import { renderFetchedPage, renderFindings } from '../render'
import { EWebSearchBackend } from '../search'

const page = {
  url: 'https://example.com/',
  finalUrl: 'https://example.com/',
  bytes: 100,
  body: 'the body',
  truncated: false,
}

describe('renderFetchedPage', () => {
  it('says nothing about a redirect when there was none', () => {
    expect(renderFetchedPage(page)).not.toContain('Redirected')
  })

  it('names both urls when the page actually moved', () => {
    const moved = renderFetchedPage({ ...page, finalUrl: 'https://example.com/docs.md' })
    expect(moved).toContain('Redirected to: https://example.com/docs.md')
  })

  it('admits when the page was cut rather than letting it read as whole', () => {
    expect(renderFetchedPage({ ...page, truncated: true })).toContain('cut off')
  })

  it('always hands the body over inside the envelope', () => {
    const rendered = renderFetchedPage({ ...page, title: 'A Title' })
    expect(rendered).toContain('Title: A Title')
    expect(rendered).toContain('<untrusted-content source="https://example.com/">')
    expect(rendered).toContain('the body')
  })
})

describe('renderFindings', () => {
  const findings = {
    query: 'bun glob',
    backend: EWebSearchBackend.DuckDuckGo,
    results: [
      { title: 'Glob', url: 'https://bun.com/glob', snippet: 'native globbing' },
      { title: 'Ref', url: 'https://bun.com/ref', content: 'the whole page text' },
    ],
  }

  it('numbers the results and wraps the lot once', () => {
    const rendered = renderFindings(findings)
    expect(rendered).toContain('1. Glob')
    expect(rendered).toContain('https://bun.com/glob')
    expect(rendered).toContain('native globbing')
    expect(rendered).toContain('2. Ref')
    expect(rendered).toContain('the whole page text')
    expect(rendered.split('<untrusted-content').length - 1).toBe(1)
  })

  it('says plainly when a search found nothing, without an empty envelope', () => {
    const rendered = renderFindings({ ...findings, results: [] })
    expect(rendered).toContain('No results')
    expect(rendered).not.toContain('untrusted-content')
  })
})
