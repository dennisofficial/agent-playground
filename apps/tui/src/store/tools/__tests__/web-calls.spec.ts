import { describe, expect, it } from 'bun:test'

import type { ToolCall } from '../../tool-runs'
import { classify } from '../classify'
import { EDetail, EGather, EToolClass } from '../kinds'
import { hostOf } from '../reading'

const settled = (args: { name: string; input: unknown; output: unknown }): ToolCall =>
  ({
    callId: 'call-1',
    name: args.name,
    input: args.input,
    output: args.output,
    state: 'ok',
    note: null,
    modelText: '',
  }) as unknown as ToolCall

const cwd = '/work'

describe('hostOf', () => {
  it('drops the scheme, the www and a trailing slash', () => {
    expect(hostOf('https://www.example.com/docs/')).toBe('example.com/docs')
    expect(hostOf('https://example.com/')).toBe('example.com')
  })

  it('hands back what it was given when that is not a url', () => {
    expect(hostOf('not a url')).toBe('not a url')
  })
})

describe('a settled web_fetch', () => {
  it('browses rather than reads, so the sentence does not count it as a file', () => {
    const found = classify({
      call: settled({
        name: 'web_fetch',
        input: { url: 'https://bun.com/docs/runtime/glob' },
        output: {
          finalUrl: 'https://bun.com/docs/runtime/glob',
          bytes: 100,
          body: 'x',
          truncated: false,
        },
      }),
      cwd,
    })

    expect(found.klass).toBe(EToolClass.Gathered)
    expect(found.gather).toBe(EGather.Browse)
    expect(found.detail).toBe(EDetail.Page)
    expect(found.line).toBe('bun.com/docs/runtime/glob')
    expect(found.failed).toBe(false)
  })

  it('counts the matches when a pattern narrowed the page', () => {
    const found = classify({
      call: settled({
        name: 'web_fetch',
        input: { url: 'https://a.test', pattern: 'scanSync' },
        output: {
          finalUrl: 'https://a.test',
          bytes: 1,
          body: 'x',
          truncated: false,
          pattern: 'scanSync',
          matched: 3,
        },
      }),
      cwd,
    })

    expect(found.note).toBe('3 matches')
    expect(found.detail).toBe(EDetail.Page)
  })

  it('marks a page that came back cut', () => {
    const found = classify({
      call: settled({
        name: 'web_fetch',
        input: { url: 'https://a.test' },
        output: { finalUrl: 'https://a.test', bytes: 1, body: 'x', truncated: true },
      }),
      cwd,
    })

    expect(found.note).toBe('cut')
  })
})

describe('a settled web_search', () => {
  it('is named by its query and counts what it found', () => {
    const found = classify({
      call: settled({
        name: 'web_search',
        input: { query: 'bun glob api' },
        output: {
          query: 'bun glob api',
          backend: 'duckduckgo',
          results: [
            { title: 'a', url: 'https://a.test' },
            { title: 'b', url: 'https://b.test' },
          ],
        },
      }),
      cwd,
    })

    expect(found.gather).toBe(EGather.Browse)
    expect(found.detail).toBe(EDetail.Results)
    expect(found.line).toBe('bun glob api')
    expect(found.note).toBe('2 results')
    expect(found.alone).toBe('Searched the web for bun glob api')
  })

  it('does not join the grep clause, so a sentence cannot count a web query as a file search', () => {
    const web = classify({
      call: settled({ name: 'web_search', input: { query: 'q' }, output: { results: [] } }),
      cwd,
    })
    const grep = classify({
      call: settled({ name: 'grep', input: { pattern: 'q' }, output: { matches: [] } }),
      cwd,
    })

    expect(web.gather).not.toBe(grep.gather)
  })
})
