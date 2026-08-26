import { describe, expect, it } from 'bun:test'

import {
  blockComment,
  doubleQuoted,
  hashComment,
  lineComment,
  pattern,
  quoted,
  sigilVariable,
  singleQuoted,
} from '../rules'
import { createScanner } from '../scanner'
import type { LanguageSpec } from '../spec'

const base: LanguageSpec = { filetype: 'fixture' }

const scanWith = (args: { spec: Partial<LanguageSpec>; source: string }) =>
  createScanner({ ...base, ...args.spec })(args.source)

const textOf = (args: { spec: Partial<LanguageSpec>; source: string }) =>
  scanWith(args).map(([start, end, group]) => [args.source.slice(start, end), group])

describe('lexical scanner', () => {
  it('matches a keyword only on a whole identifier', () => {
    expect(
      textOf({ spec: { words: { keyword: ['end'] } }, source: 'end endfunction bend' }),
    ).toEqual([['end', 'keyword']])
  })

  it('folds case only when the language asks for it', () => {
    const spec = { words: { keyword: ['SELECT'] } }
    expect(textOf({ spec, source: 'select' })).toEqual([])
    expect(textOf({ spec: { ...spec, caseInsensitive: true }, source: 'select' })).toEqual([
      ['select', 'keyword'],
    ])
  })

  it('takes the first rule that claims a position', () => {
    const spec = { rules: [lineComment({ open: '"', atLineStart: true }), doubleQuoted()] }
    expect(textOf({ spec, source: '" a comment\necho "a string"' })).toEqual([
      ['" a comment', 'comment'],
      ['"a string"', 'string'],
    ])
  })

  it('ends an unterminated single-line string at the line break', () => {
    expect(textOf({ spec: { rules: [doubleQuoted()] }, source: '"open\nnext' })).toEqual([
      ['"open', 'string'],
    ])
  })

  it('carries a multiline string across line breaks', () => {
    expect(
      textOf({ spec: { rules: [quoted({ open: '"""', multiline: true })] }, source: '"""a\nb"""' }),
    ).toEqual([['"""a\nb"""', 'string']])
  })

  it('honours a backslash escape inside a string', () => {
    expect(textOf({ spec: { rules: [doubleQuoted()] }, source: '"a\\"b" tail' })).toEqual([
      ['"a\\"b"', 'string'],
    ])
  })

  it('honours a doubled-quote escape instead of a backslash', () => {
    expect(
      textOf({ spec: { rules: [singleQuoted({ escape: null, doubled: true })] }, source: "'a''b'" }),
    ).toEqual([["'a''b'", 'string']])
  })

  it('nests a block comment only when the language nests', () => {
    const source = '(* outer (* inner *) still *)'
    expect(
      textOf({
        spec: { operators: '', rules: [blockComment({ open: '(*', close: '*)' })] },
        source,
      }),
    ).toEqual([['(* outer (* inner *)', 'comment']])
    expect(
      textOf({
        spec: { operators: '', rules: [blockComment({ open: '(*', close: '*)', nests: true })] },
        source,
      }),
    ).toEqual([[source, 'comment']])
  })

  it('closes an unterminated block comment at the end of the source', () => {
    expect(
      textOf({ spec: { rules: [blockComment({ open: '/*', close: '*/' })] }, source: '/* open' }),
    ).toEqual([['/* open', 'comment']])
  })

  it('applies a line-start rule only to the first token on a line', () => {
    expect(
      textOf({ spec: { rules: [lineComment({ open: 'C', atLineStart: true })] }, source: 'x C y\nC z' }),
    ).toEqual([['C z', 'comment']])
  })

  it('applies a column rule only at that column', () => {
    const spec = { operators: '', rules: [lineComment({ open: '*', atColumn: 6 })] }
    expect(textOf({ spec, source: '      * comment' })).toEqual([['* comment', 'comment']])
    expect(textOf({ spec, source: '     * not' })).toEqual([])
  })

  it('reads a sigil variable as one token', () => {
    expect(
      textOf({ spec: { rules: [sigilVariable({ sigil: '$' })] }, source: 'echo $name;' }),
    ).toEqual([['$name', 'variable']])
  })

  it('claims a call site only when a parenthesis follows', () => {
    expect(textOf({ spec: { call: 'function.call' }, source: 'add (x) plain' })).toEqual([
      ['add', 'function.call'],
    ])
  })

  it('reads numbers in every default base', () => {
    expect(textOf({ spec: {}, source: '0xFF 0b1010 1_000 3.14 1e9' }).map(([text]) => text)).toEqual(
      ['0xFF', '0b1010', '1_000', '3.14', '1e9'],
    )
  })

  it('runs adjacent operator characters together', () => {
    expect(textOf({ spec: {}, source: 'a <= b' })).toEqual([['<=', 'operator']])
  })

  it('leaves a keyword inside a comment or string alone', () => {
    const spec = { words: { keyword: ['end'] }, rules: [hashComment(), doubleQuoted()] }
    expect(textOf({ spec, source: '# end\n"end"\nend' })).toEqual([
      ['# end', 'comment'],
      ['"end"', 'string'],
      ['end', 'keyword'],
    ])
  })

  it('resumes line-start tracking after a multiline token', () => {
    const spec = {
      operators: '',
      rules: [quoted({ open: '"""', multiline: true }), lineComment({ open: '%', atLineStart: true })],
    }
    expect(textOf({ spec, source: '"""a\nb""" % not a comment\n% a comment' })).toEqual([
      ['"""a\nb"""', 'string'],
      ['% a comment', 'comment'],
    ])
  })

  it('emits highlights in source order without overlap', () => {
    const highlights = scanWith({
      spec: { rules: [hashComment(), doubleQuoted()], words: { keyword: ['def'] } },
      source: 'def f\n  # c\n  "s"\nend\n',
    })

    let previous = 0
    for (const [start, end] of highlights) {
      expect(start).toBeGreaterThanOrEqual(previous)
      expect(end).toBeGreaterThan(start)
      previous = end
    }
  })

  it('narrows the identifier alphabet when the language declares one', () => {
    expect(
      textOf({
        spec: { identifier: /[A-Za-z_+*/<>=!?-][A-Za-z0-9_+*/<>=!?-]*/, words: { keyword: ['defn'] } },
        source: '(defn add [a b] (+ a b))',
      }),
    ).toEqual([['defn', 'keyword']])
  })

  it('accepts a rule pattern already carrying flags', () => {
    expect(
      textOf({ spec: { rules: [pattern({ match: /[A-Z]+/g, group: 'type' })] }, source: '(BC)' }),
    ).toEqual([['BC', 'type']])
  })

  it('lets an identifier swallow a pattern that would only match inside it', () => {
    expect(
      textOf({ spec: { rules: [pattern({ match: /[A-Z]+/, group: 'type' })] }, source: 'aBC' }),
    ).toEqual([])
  })
})
