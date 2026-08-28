import { describe, expect, it } from 'bun:test'

import { commandLineOf, mentionSpans } from '../mention'

const names = (text: string): readonly string[] => mentionSpans(text).map((found) => found.name)

describe('mentionSpans', () => {
  it('finds a mention at the start of the text', () => {
    expect(names('/review')).toEqual(['review'])
  })

  it('finds a mention in the middle of prose', () => {
    expect(names('please use /tdd and /implement here')).toEqual(['tdd', 'implement'])
  })

  it('reads a qualified name', () => {
    expect(names('/skill:review')).toEqual(['skill:review'])
  })

  it('reports where each mention sits so the composer can paint it', () => {
    expect(mentionSpans('use /tdd now')).toEqual([{ start: 4, end: 8, name: 'tdd' }])
  })

  describe('is not fooled by paths and urls', () => {
    it('ignores an absolute path', () => {
      expect(names('/Users/dennis/notes.md')).toEqual([])
    })

    it('ignores a path inside prose', () => {
      expect(names('see /docs/setup for more')).toEqual([])
    })

    it('ignores a url', () => {
      expect(names('read https://example.com/tdd today')).toEqual([])
    })

    it('ignores a slash glued to a preceding word', () => {
      expect(names('src/tdd')).toEqual([])
    })
  })

  describe('backticks suppress', () => {
    it('ignores a mention inside a code span', () => {
      expect(names('type `/tdd` to start')).toEqual([])
    })

    it('ignores a mention inside a fenced block', () => {
      expect(names('```\n/tdd\n```')).toEqual([])
    })

    it('still reads a mention outside the span', () => {
      expect(names('`/tdd` but really /implement')).toEqual(['implement'])
    })

    it('lets an unmatched backtick suppress nothing', () => {
      expect(names('a stray ` and then /tdd')).toEqual(['tdd'])
    })
  })
})

describe('commandLineOf', () => {
  it('is null when the text does not open with a mention', () => {
    expect(commandLineOf('please use /tdd')).toBeNull()
  })

  it('reads a lone command and its arguments', () => {
    expect(commandLineOf('/review src/auth.ts')).toEqual({
      names: ['review'],
      argumentText: 'src/auth.ts',
    })
  })

  it('chains leading commands and hands the rest to each', () => {
    expect(commandLineOf('/tdd /implement do X')).toEqual({
      names: ['tdd', 'implement'],
      argumentText: 'do X',
    })
  })

  it('stops chaining once prose intervenes', () => {
    expect(commandLineOf('/tdd then /implement')).toEqual({
      names: ['tdd'],
      argumentText: 'then /implement',
    })
  })

  it('caps a chain at six', () => {
    const line = commandLineOf('/a /b /c /d /e /f /g rest')
    expect(line?.names).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
  })

  it('carries an empty argument text when nothing follows', () => {
    expect(commandLineOf('/compact')).toEqual({ names: ['compact'], argumentText: '' })
  })
})
