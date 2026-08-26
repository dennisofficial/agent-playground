import { describe, expect, it } from 'bun:test'

import { expectLexes, expectPlain, groupsIn, textFor } from '../../__tests__/harness'
import { forth as spec } from '../forth'

const source = [
  '\\ a tiny calculator',
  'decimal',
  '',
  'variable scale',
  '2 scale !',
  '',
  ': add ( n1 n2 -- n3 )',
  '  + ;',
  '',
  ': multiply ( n1 n2 -- n3 )',
  '  scale @ * * ;',
  '',
  ': report ( n -- )',
  '  ." result: " . cr ;',
  '',
  ': nonzero? ( n -- flag )',
  '  0= if false else true then ;',
  '',
  ': triangle ( n -- n )',
  '  0 swap 0 do i + loop ;',
  '',
  '$ff constant mask',
  ': masked ( n -- n ) mask and ;',
  '',
  ': checked ( n -- n )',
  '  dup 0< abort" negative" ;',
  '',
  '(',
  '  demo drives every word above',
  ')',
  ': demo ( -- )',
  '  5 3 add report',
  '  5 3 multiply report ;',
  '',
  'demo',
  '',
].join('\n')

describe('forth lexical highlighting', () => {
  it('lexes a representative sample', () => {
    expectLexes({
      spec,
      source,
      groups: [
        'comment',
        'string',
        'keyword',
        'function',
        'function.builtin',
        'constant.builtin',
        'variable',
        'operator',
        'number',
      ],
    })
  })

  it('reads the colon and semicolon definition words as keywords', () => {
    const keywords = textFor({ spec, source, group: 'keyword' })
    expect(keywords.filter((word) => word === ':')).toHaveLength(8)
    expect(keywords.filter((word) => word === ';')).toHaveLength(8)
  })

  it('reads the word being defined as a function', () => {
    expect(textFor({ spec, source, group: 'function' })).toEqual([
      'add',
      'multiply',
      'report',
      'nonzero?',
      'triangle',
      'masked',
      'checked',
      'demo',
    ])
  })

  it('reads the name a data-defining word introduces as a variable', () => {
    expect(textFor({ spec, source, group: 'variable' })).toEqual(['scale', 'mask'])
  })

  it('does not carry a data-defining word across a line break', () => {
    expectPlain({ spec, source: 'variable\nscale !', text: 'scale' })
  })

  it('reads a backslash line comment and a parenthesised stack comment', () => {
    expect(textFor({ spec, source, group: 'comment' })).toEqual([
      '\\ a tiny calculator',
      '( n1 n2 -- n3 )',
      '( n1 n2 -- n3 )',
      '( n -- )',
      '( n -- flag )',
      '( n -- n )',
      '( n -- n )',
      '( n -- n )',
      '(\n  demo drives every word above\n)',
      '( -- )',
    ])
  })

  it('opens a backslash comment on a tab as readily as on a space', () => {
    const tabbed = '\\\tif then dup 42\ndup\n'
    expect(textFor({ spec, source: tabbed, group: 'comment' })).toEqual(['\\\tif then dup 42'])
    expect([...groupsIn({ spec, source: tabbed })]).not.toContain('keyword')
  })

  it('reads a backslash alone on its line as an empty comment', () => {
    expect(textFor({ spec, source: 'dup\n\\\ndrop\n', group: 'comment' })).toEqual(['\\'])
  })

  it('opens a stack comment when the parenthesis is followed by a newline', () => {
    const block = '(\n  if then dup 42\n)\ndup\n'
    expect(textFor({ spec, source: block, group: 'comment' })).toEqual(['(\n  if then dup 42\n)'])
    expect([...groupsIn({ spec, source: block })]).not.toContain('keyword')
  })

  it('closes a stack comment on the first parenthesis, which does not nest', () => {
    expect(textFor({ spec, source: '( outer ( inner ) still )\ndup', group: 'comment' })).toEqual([
      '( outer ( inner )',
    ])
  })

  it('reads a string from any word whose last character is a quote', () => {
    expect(
      textFor({ spec, source: 'abort" bad" s" ok" C" ok" ." ok" type', group: 'string' }),
    ).toEqual(['abort" bad"', 's" ok"', 'C" ok"', '." ok"'])
  })

  it('reads a printed string from the dot-quote word to the closing quote', () => {
    expect(textFor({ spec, source, group: 'string' })).toEqual([
      '." result: "',
      'abort" negative"',
    ])
  })

  it('stops an unclosed printed string at the end of its line', () => {
    expect(textFor({ spec, source: ': x ." oops\n  cr ;', group: 'string' })).toEqual(['." oops'])
  })

  it('reads prefixed radix literals as numbers', () => {
    expect(textFor({ spec, source: '$ff #99 %1011 -7 3.14 1. .s', group: 'number' })).toEqual([
      '$ff',
      '#99',
      '%1011',
      '-7',
      '3.14',
      '1.',
    ])
  })

  it('keeps a word made of digits and punctuation whole', () => {
    expect(textFor({ spec, source: '5 1+ 2* .', group: 'function.builtin' })).toEqual([
      '1+',
      '2*',
      '.',
    ])
  })

  it('does not open a stack comment on a parenthesis glued to a digit', () => {
    const glued = '3 (2drop) execute'
    expect([...groupsIn({ spec, source: glued })]).not.toContain('comment')
    expectPlain({ spec, source: glued, text: '(2drop)' })
  })

  it('does not open a string on a quote that is a word of its own', () => {
    const literal = 'char " 42 emit'
    expect(textFor({ spec, source: literal, group: 'string' })).toEqual([])
    expectPlain({ spec, source: literal, text: '" 42 emit' })
  })

  it('does not open a string on a quote buried inside a word', () => {
    expectPlain({ spec, source: 'foo"bar" baz', text: 'foo"bar"' })
  })

  it('leaves a user-defined word alone at its call site', () => {
    expectPlain({ spec, source, text: 'mask and' })
  })

  it('answers to the fth and 4th aliases too', () => {
    expect(spec.aliases).toEqual(['fth', '4th'])
  })
})
