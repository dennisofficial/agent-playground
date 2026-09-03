import { describe, expect, it } from 'bun:test'

import { EFenceState, growingSegments, segmentMarkdown, steadySegments } from '../segment'

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
    expect(segments[1]).toEqual({
      kind: 'fence',
      language: 'ts',
      filename: '',
      source: 'const x = 1;',
      raw: '```ts\nconst x = 1;\n```',
      state: EFenceState.Closed,
    })
    expect(segments[2]).toEqual({ kind: 'prose', text: '\n\nTrailing prose.\n' })
  })

  it('pulls a top-level fence out with its language lowercased', () => {
    const segments = segmentMarkdown('```TypeScript\nconst x = 1;\n```')
    expect(segments).toEqual([
      {
        kind: 'fence',
        language: 'typescript',
        filename: '',
        source: 'const x = 1;',
        raw: '```TypeScript\nconst x = 1;\n```',
        state: EFenceState.Closed,
      },
    ])
  })

  it('takes only the first word of an info string as the language', () => {
    const segments = segmentMarkdown('```ts title="a.ts"\nconst x = 1;\n```')
    expect(segments[0]).toMatchObject({ kind: 'fence', language: 'ts' })
  })

  it('gives an unlabelled fence an empty language rather than guessing one', () => {
    expect(segmentMarkdown('```\nplain\n```')[0]).toEqual({
      kind: 'fence',
      language: '',
      filename: '',
      source: 'plain',
      raw: '```\nplain\n```',
      state: EFenceState.Closed,
    })
  })

  it('gives a 4-space-indented block the same shape as a backtick fence', () => {
    // marked leaves a trailing newline on this flavour and not on the other; both arrive here
    // without one, so a renderer downstream cannot tell which the author wrote.
    expect(segmentMarkdown('    indented code\n')[0]).toEqual({
      kind: 'fence',
      language: '',
      filename: '',
      source: 'indented code',
      raw: '    indented code\n',
      state: EFenceState.Closed,
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

describe('steadySegments', () => {
  const steady = (source: string) => steadySegments({ segments: segmentMarkdown(source) })

  const shapeOf = (source: string) =>
    steady(source).map((segment) =>
      segment.kind === 'fence' ? `fence(${segment.language}):${segment.source}` : segment.kind,
    )

  it('withholds a fence whose info string is still being typed', () => {
    expect(shapeOf('Here:\n\n``')).toEqual(['prose'])
    expect(shapeOf('Here:\n\n```')).toEqual(['prose'])
    expect(shapeOf('Here:\n\n```t')).toEqual(['prose'])
    expect(shapeOf('Here:\n\n```ts')).toEqual(['prose'])
  })

  it('shows a fence only once its language is settled', () => {
    expect(shapeOf('```ts\nconst a = 1\n')).toEqual(['fence(ts):const a = 1'])
  })

  it('withholds the line still being written, so the highlighter sees whole lines', () => {
    expect(shapeOf('```ts\nconst a = 1\nconst b')).toEqual(['fence(ts):const a = 1'])
    expect(shapeOf('```ts\nconst a = 1\nconst b = 2')).toEqual(['fence(ts):const a = 1'])
    expect(shapeOf('```ts\nconst a = 1\nconst b = 2\n')).toEqual([
      'fence(ts):const a = 1\nconst b = 2',
    ])
  })

  it('holds an open fence back entirely until its first line lands', () => {
    expect(shapeOf('```ts\n')).toEqual([])
    expect(shapeOf('```ts\nconst')).toEqual([])
  })

  it('leaves a closed fence whole, last line and all', () => {
    expect(shapeOf('```ts\nconst a = 1\nconst b = 2\n```')).toEqual([
      'fence(ts):const a = 1\nconst b = 2',
    ])
  })

  it('leaves a fence that is no longer the trailing segment alone', () => {
    expect(shapeOf('```ts\nconst a = 1\n```\n\nAnd then.')).toEqual([
      'fence(ts):const a = 1',
      'prose',
    ])
  })

  it('touches nothing when the document ends in prose or a table', () => {
    const table = ['| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n')
    expect(shapeOf('just prose')).toEqual(['prose'])
    expect(shapeOf(table)).toEqual(['table'])
  })

  it('recognises a tilde fence and a closer longer than its opener', () => {
    expect(shapeOf('~~~ts\nconst a = 1\nconst b')).toEqual(['fence(ts):const a = 1'])
    expect(shapeOf('```ts\nconst a = 1\n`````')).toEqual(['fence(ts):const a = 1'])
  })
})

describe('growingSegments', () => {
  const grown = (source: string) => growingSegments({ source })

  it('keeps settled segment identity while only the tail grows', () => {
    const prefix = '# Heading\n\n```ts\nconst a = 1\n```\n\n'
    const first = grown(`${prefix}tail begins`)
    const second = grown(`${prefix}tail begins and keeps going`)

    expect(second[0]).toBe(first[0])
    expect(second[1]).toBe(first[1])
  })

  it('reuses the same settled objects across a whole boundary crossing', () => {
    const prefix = '# Heading\n\n```ts\nconst a = 1\n```\n\n'
    const before = grown(`${prefix}second paragraph\n\nthird`)
    const after = grown(`${prefix}second paragraph\n\nthird grows`)

    expect(after[0]).toBe(before[0])
    expect(after[1]).toBe(before[1])
  })

  it('coalesces prose across the seam into the one segment a batch lex yields', () => {
    expect(grown('- one\n\n- two\n\n- three')).toEqual(segmentMarkdown('- one\n\n- two\n\n- three'))
  })

  it('matches the batch lex at every step of a growing message', () => {
    const message = [
      '# Plan',
      '',
      'Opening prose with `inline code` and a [link](https://example.com).',
      '',
      '- one',
      '',
      '- two',
      '',
      '```ts',
      'const a = 1;',
      '',
      'const b = 2;',
      '```',
      '',
      '> quoted',
      '>',
      '> ```ts',
      '> nested',
      '> ```',
      '',
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      '~~~py',
      'print("hi")',
      '~~~',
      '',
      '    indented code',
      '',
      'Closing words.',
    ].join('\n')

    for (let end = 0; end <= message.length; end += 1) {
      const slice = message.slice(0, end)
      expect(grown(slice)).toEqual(segmentMarkdown(slice))
    }
  })

  it('matches the batch lex for a fence that streams blank lines of its own', () => {
    const message = 'Before.\n\n```ts\nconst a = 1;\n\n\nconst b = 2;\n\n```\n\nAfter.'
    for (let end = 0; end <= message.length; end += 1) {
      const slice = message.slice(0, end)
      expect(grown(slice)).toEqual(segmentMarkdown(slice))
    }
  })

  it('keeps every character of the source across the segments it returns', () => {
    const source = '# h\n\n```ts\ncode\n```\n\n| a |\n| - |\n| 1 |\n\ntrail\n'
    const text = grown(source)
      .map((segment) => {
        if (segment.kind === 'prose') return segment.text
        if (segment.kind === 'fence') return segment.raw
        return segment.markdown
      })
      .join('')
    expect(text).toBe(source)
  })
})
