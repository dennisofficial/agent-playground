import { describe, expect, it } from 'bun:test'

import { expectLexes, expectPlain, groupsIn, textFor } from '../../__tests__/harness'
import { smalltalk as spec } from '../smalltalk'

const source = [
  '"A tiny calculator."',
  'Object subclass: Calculator [',
  '    | scale |',
  '',
  '    Calculator class >> scaledBy: aNumber [',
  '        ^self new setScale: aNumber',
  '    ]',
  '',
  '    setScale: aNumber [',
  '        scale := aNumber.',
  '        ^self',
  '    ]',
  '',
  '    add: x to: y [',
  '        ^x + y',
  '    ]',
  '',
  '    multiply: x by: y [',
  '        | product |',
  '        product := x * y * scale.',
  '        ^product',
  '    ]',
  '',
  '    printOn: aStream [',
  '        super printOn: aStream.',
  "        aStream nextPutAll: ' scale: '; print: scale",
  '    ]',
  ']',
  '',
  '| calc squares |',
  'calc := Calculator scaledBy: 2.',
  'Transcript showCr: (calc add: 2 to: 40) printString.',
  'Transcript showCr: (calc multiply: 5 by: 3) printString.',
  'squares := #(1 4 9) collect: [:each | each * each].',
  "squares do: [:n | Transcript show: n printString] separatedBy: [Transcript show: ', '].",
  'Transcript showCr: (calc respondsTo: #multiply:by:) printString.',
  '$a printNl.',
  '16r1F printNl.',
  '3.14s2 printNl.',
  "nil isNil ifTrue: [Transcript showCr: 'nil at last'].",
  '',
].join('\n')

describe('smalltalk lexical highlighting', () => {
  it('lexes a representative sample', () => {
    expectLexes({
      spec,
      source,
      groups: [
        'comment',
        'string',
        'string.special.symbol',
        'character',
        'function.method',
        'function.builtin',
        'constant.builtin',
        'variable.parameter',
        'keyword.return',
        'type',
        'number',
        'operator',
      ],
    })
  })

  it('reads a double-quoted span as a comment and a single-quoted one as a string', () => {
    const inverted = ['"a \'quoted\' aside"', 'Transcript showCr: \'say "hi"\'.'].join('\n')

    expect(textFor({ spec, source: inverted, group: 'comment' })).toEqual(["\"a 'quoted' aside\""])
    expect(textFor({ spec, source: inverted, group: 'string' })).toEqual(['\'say "hi"\''])
  })

  it('closes a string on the doubled quote, not on the first half of it', () => {
    const doubled = "message := 'can''t divide'."

    expect(textFor({ spec, source: doubled, group: 'string' })).toEqual(["'can''t divide'"])
  })

  it('keeps a colon-bearing selector inside a string out of the lexer', () => {
    expect(textFor({ spec, source, group: 'string' })).toEqual([
      "' scale: '",
      "', '",
      "'nil at last'",
    ])
  })

  it('reads a keyword message as a method selector, colon and all', () => {
    expect(textFor({ spec, source, group: 'function.method' })).toEqual([
      'subclass:',
      'scaledBy:',
      'setScale:',
      'setScale:',
      'add:',
      'to:',
      'multiply:',
      'by:',
      'printOn:',
      'printOn:',
      'nextPutAll:',
      'print:',
      'scaledBy:',
      'showCr:',
      'add:',
      'to:',
      'showCr:',
      'multiply:',
      'by:',
      'collect:',
      'do:',
      'show:',
      'separatedBy:',
      'show:',
      'showCr:',
      'respondsTo:',
      'ifTrue:',
      'showCr:',
    ])
  })

  it('reads hash-prefixed symbols and literal arrays as symbols', () => {
    expect(textFor({ spec, source, group: 'string.special.symbol' })).toEqual([
      '#(',
      '#multiply:by:',
    ])
    expect(textFor({ spec, source: 'sel := #at:put:. op := #+. q := #\'odd one\'.', group: 'string.special.symbol' })).toEqual([
      '#at:put:',
      '#+',
      "#'odd one'",
    ])
  })

  it('reads a dollar-prefixed character literal', () => {
    expect(textFor({ spec, source, group: 'character' })).toEqual(['$a'])
    expect(textFor({ spec, source: "Transcript nextPut: $'; nextPut: $ .", group: 'character' })).toEqual([
      "$'",
      '$ ',
    ])
  })

  it('reads block parameters as parameters', () => {
    expect(textFor({ spec, source, group: 'variable.parameter' })).toEqual([':each', ':n'])
  })

  it('reads the caret as a return and the colon-equals as an operator', () => {
    expect(textFor({ spec, source: '^total := 1 + 2', group: 'keyword.return' })).toEqual(['^'])
    expect(textFor({ spec, source: '^total := 1 + 2', group: 'operator' })).toEqual([':=', '+'])
  })

  it('reads a space-free assignment as an assignment, not a keyword selector', () => {
    const tight = 'total:=1.'

    expect(textFor({ spec, source: tight, group: 'operator' })).toEqual([':='])
    expect(groupsIn({ spec, source: tight })).not.toContain('function.method')
    expectPlain({ spec, source: tight, text: 'total' })
  })

  it('reads uppercase-initial names as types', () => {
    expect(textFor({ spec, source, group: 'type' })).toEqual([
      'Object',
      'Calculator',
      'Calculator',
      'Calculator',
      'Transcript',
      'Transcript',
      'Transcript',
      'Transcript',
      'Transcript',
      'Transcript',
    ])
  })

  it('reads radix and scaled-decimal literals whole', () => {
    expect(textFor({ spec, source, group: 'number' })).toEqual([
      '2',
      '2',
      '40',
      '5',
      '3',
      '1',
      '4',
      '9',
      '16r1F',
      '3.14s2',
    ])
  })

  it('leaves an ordinary temporary alone', () => {
    expectPlain({ spec, source, text: 'product' })
  })

  it('carries a class comment across the newline as one string', () => {
    const wrapped = [
      "Calculator comment: 'Adds and multiplies.",
      "Use #scaledBy: to build one.'.",
      "Transcript showCr: 'after'.",
    ].join('\n')

    expect(textFor({ spec, source: wrapped, group: 'string' })).toEqual([
      "'Adds and multiplies.\nUse #scaledBy: to build one.'",
      "'after'",
    ])
    expect(groupsIn({ spec, source: wrapped })).not.toContain('string.special.symbol')
    expect(textFor({ spec, source: wrapped, group: 'type' })).toEqual([
      'Calculator',
      'Transcript',
    ])
  })

  it('reads the backslash binary selectors as operators', () => {
    const remainder = 'rest := n \\\\ 3. half := n // 2.'

    expect(textFor({ spec, source: remainder, group: 'operator' })).toEqual([
      ':=',
      '\\\\',
      ':=',
      '//',
    ])
  })

  it('reads the message-style class definition as selectors and strings', () => {
    const defined = [
      'Object subclass: #Calculator',
      "    instanceVariableNames: 'scale'",
      "    classVariableNames: ''",
      "    package: 'Calculator-Core'",
    ].join('\n')

    expect(textFor({ spec, source: defined, group: 'function.method' })).toEqual([
      'subclass:',
      'instanceVariableNames:',
      'classVariableNames:',
      'package:',
    ])
    expect(textFor({ spec, source: defined, group: 'string.special.symbol' })).toEqual([
      '#Calculator',
    ])
    expect(textFor({ spec, source: defined, group: 'string' })).toEqual([
      "'scale'",
      "''",
      "'Calculator-Core'",
    ])
  })

  it('answers to the st alias too', () => {
    expect(spec.aliases).toContain('st')
  })
})
