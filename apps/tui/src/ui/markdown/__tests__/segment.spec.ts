import { describe, expect, it } from 'bun:test'

import { segmentMarkdown } from '../segment'

describe('segmentMarkdown', () => {
  it('hands prose across verbatim, never reflowed or re-rendered', () => {
    const source = [
      '## A heading',
      '',
      'Prose with `code` and a [link](https://example.com).',
      '',
      '```ts',
      'const x = 1;',
      '```',
      '',
      'Trailing prose.',
      '',
    ].join('\n')

    const segments = segmentMarkdown(source)

    expect(segments.map((segment) => segment.kind)).toEqual(['prose', 'fence', 'prose'])
    expect(segments[0]).toEqual({
      kind: 'prose',
      text: '## A heading\n\nProse with `code` and a [link](https://example.com).\n\n',
    })
    expect(segments[1]).toEqual({ kind: 'fence', language: 'ts', source: 'const x = 1;' })
    // The blank line closing the fence belongs to the prose that follows it, so the fence and the
    // paragraph after it are not run together.
    expect(segments[2]).toEqual({ kind: 'prose', text: '\n\nTrailing prose.\n' })
  })

  it('pulls a top-level fence out with its language lowercased', () => {
    const segments = segmentMarkdown('```TypeScript\nconst x = 1;\n```')
    expect(segments).toEqual([{ kind: 'fence', language: 'typescript', source: 'const x = 1;' }])
  })

  it('takes only the first word of an info string as the language', () => {
    const segments = segmentMarkdown('```ts title="a.ts"\nconst x = 1;\n```')
    expect(segments[0]).toMatchObject({ kind: 'fence', language: 'ts' })
  })

  it('gives an unlabelled fence an empty language rather than guessing one', () => {
    expect(segmentMarkdown('```\nplain\n```')[0]).toEqual({
      kind: 'fence',
      language: '',
      source: 'plain',
    })
  })

  it('gives a 4-space-indented block the same shape as a backtick fence', () => {
    // marked leaves a trailing newline on this flavour and not on the other; both arrive here
    // without one, so a renderer downstream cannot tell which the author wrote.
    expect(segmentMarkdown('    indented code\n')[0]).toEqual({
      kind: 'fence',
      language: '',
      source: 'indented code',
    })
  })

  it('keeps a table whole and separate, because reflowing it would destroy it', () => {
    const table = ['| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n')
    const segments = segmentMarkdown(`before\n\n${table}\n\nafter`)

    expect(segments.map((segment) => segment.kind)).toEqual(['prose', 'table', 'prose'])
    expect(segments[1]).toMatchObject({ kind: 'table' })
  })

  it('leaves a fence nested in a blockquote or list inside the prose stream', () => {
    // The prose renderer draws those as `markup.raw.block`; lifting them out would break the quote.
    const segments = segmentMarkdown('> quoted\n>\n> ```ts\n> const x = 1;\n> ```\n')
    expect(segments.map((segment) => segment.kind)).toEqual(['prose'])
  })

  it('coalesces runs of prose into one segment rather than one per token', () => {
    const segments = segmentMarkdown('# h\n\npara one\n\n- a\n- b\n')
    expect(segments).toHaveLength(1)
    expect(segments[0]?.kind).toBe('prose')
  })

  it('returns nothing at all for an empty document', () => {
    expect(segmentMarkdown('')).toEqual([])
  })
})
