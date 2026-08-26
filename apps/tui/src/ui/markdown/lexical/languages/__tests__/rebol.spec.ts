import { describe, expect, it } from 'bun:test'

import { expectLexes, expectPlain, groupsIn, textFor } from '../../__tests__/harness'
import { rebol as spec } from '../rebol'

const source = [
  '; a calculator in Rebol',
  'Rebol [Title: "Calculator"]',
  '',
  'verbose?: true',
  'banner: "Calc ^"v1^" ready"',
  '',
  'add: func [a [integer!] b [integer!]] [a + b]',
  '',
  'calculator: context [',
  '    scale: 2',
  '    label: {a {nested} note}',
  '    multiply: func [x [integer!] y [integer!] /local total] [',
  '        total: x * y',
  '        either any [zero? x zero? y] [0] [total * scale]',
  '    ]',
  ']',
  '',
  'describe: func [value [any-type!]] [',
  '    unless verbose? [return mold value]',
  '    either none? value [copy "nothing"] [form value]',
  ']',
  '',
  'print banner',
  'print to-string add 5 3',
  'print calculator/multiply 5 3',
  'print describe calculator/label',
  '',
].join('\n')

describe('rebol lexical highlighting', () => {
  it('lexes a representative sample', () => {
    expectLexes({
      spec,
      source,
      groups: [
        'comment',
        'string',
        'keyword',
        'type',
        'variable',
        'number',
        'operator',
        'function.builtin',
        'constant.builtin',
      ],
    })
  })

  it('reads every definition as a set-word', () => {
    expect(textFor({ spec, source, group: 'variable' })).toEqual([
      'Title:',
      'verbose?:',
      'banner:',
      'add:',
      'calculator:',
      'scale:',
      'label:',
      'multiply:',
      'total:',
      'describe:',
    ])
  })

  it('reads a bang-terminated word as a datatype', () => {
    expect(textFor({ spec, source, group: 'type' })).toEqual([
      'integer!',
      'integer!',
      'integer!',
      'integer!',
      'any-type!',
    ])
  })

  it('reads both string forms, braces included', () => {
    expect(textFor({ spec, source, group: 'string' })).toEqual([
      '"Calculator"',
      '"Calc ^"v1^" ready"',
      '{a {nested} note}',
      '"nothing"',
    ])
  })

  it('closes a braced string only at the brace that matches', () => {
    const braced = 'note: {outer {inner} outer}'
    expect(textFor({ spec, source: braced, group: 'string' })).toEqual(['{outer {inner} outer}'])
    expect(groupsIn({ spec, source: braced })).toEqual(new Set(['variable', 'string']))
  })

  it('escapes a quote with a caret and leaves a backslash literal', () => {
    const carets = 'print "Use ^"quotes^" here"'
    expect(textFor({ spec, source: carets, group: 'string' })).toEqual(['"Use ^"quotes^" here"'])

    const backslash = 'path: "C:\\temp\\" print "after"'
    expect(textFor({ spec, source: backslash, group: 'string' })).toEqual([
      '"C:\\temp\\"',
      '"after"',
    ])
  })

  it('reads a bang-ending set-word as a definition, not a datatype', () => {
    const declared = 'point!: make object! [x: 0 y: 0]'
    expect(textFor({ spec, source: declared, group: 'variable' })).toEqual(['point!:', 'x:', 'y:'])
    expect(textFor({ spec, source: declared, group: 'type' })).toEqual(['object!'])
  })

  it('reads a hyphenated word as one token', () => {
    const hyphenated = 'do-nothing: does [print "ok"]'
    expect(textFor({ spec, source: hyphenated, group: 'variable' })).toEqual(['do-nothing:'])
    expect(textFor({ spec, source: hyphenated, group: 'keyword' })).toEqual(['does'])
    expect(textFor({ spec, source: hyphenated, group: 'operator' })).toEqual([])
    expect(textFor({ spec, source: 'total: to-string length? data', group: 'operator' })).toEqual([])
  })

  it('folds keyword case', () => {
    expect(textFor({ spec, source: 'EITHER TRUE [1] [2]', group: 'keyword' })).toEqual(['EITHER'])
    expect(textFor({ spec, source: 'EITHER TRUE [1] [2]', group: 'constant.builtin' })).toEqual([
      'TRUE',
    ])
  })

  it('leaves a predicate that merely starts with a constant alone', () => {
    expectPlain({ spec, source, text: 'none?' })
  })

  it('leaves an uppercase word uncoloured so no rule can eat a keyword', () => {
    expectPlain({ spec, source, text: 'Rebol [' })
  })

  it('answers to the red alias too', () => {
    expect(spec.aliases).toContain('red')
  })
})
