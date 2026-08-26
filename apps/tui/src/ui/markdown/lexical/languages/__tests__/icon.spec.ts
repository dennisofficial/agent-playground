import { describe, expect, it } from 'bun:test'

import { expectLexes, expectPlain, groupsIn, textFor } from '../../__tests__/harness'
import { icon as spec } from '../icon'

const source = [
  '# a small calculator in Icon',
  '$define Scale 2',
  '',
  'link ximage',
  '',
  'record Calculator(scale, tally)',
  '',
  'procedure add(x, y)',
  '   return x + y',
  'end',
  '',
  'procedure multiply(calc, x, y)',
  '   local total',
  '   total := 0',
  '   every 1 to y do',
  '      total +:= x',
  '   calc.tally +:= 1',
  '   return total * calc.scale',
  'end',
  '',
  'procedure main(args)',
  '   local calc, keyname',
  '   calc := Calculator(Scale, 0)',
  '   keyname := \\args[1] | "result"',
  '   write(keyname, ": " || add(5, 3))',
  '   write("multiply: ", multiply(calc, 5, 3))',
  '   if not (calc.tally = 0) then',
  '      write(&errout, "calls: ", calc.tally, " at ", &clock)',
  '   every writes(!&lcase)',
  '   write("cs101" ? tab(upto(\'0123456789\')))',
  '   if keyname === &null then stop("no name")',
  '   write(ximage(calc))',
  'end',
  '',
].join('\n')

describe('icon lexical highlighting', () => {
  it('lexes a representative sample', () => {
    expectLexes({
      spec,
      source,
      groups: [
        'comment',
        'keyword.directive',
        'keyword',
        'string',
        'number',
        'operator',
        'function.call',
        'function.builtin',
        'constant.builtin',
        'variable.member',
      ],
    })
  })

  it('reads ampersand-led keywords as builtin constants', () => {
    expect(textFor({ spec, source, group: 'constant.builtin' })).toEqual([
      '&errout',
      '&clock',
      '&lcase',
      '&null',
    ])
  })

  it('reads a bare ampersand as conjunction, not as a keyword', () => {
    const conjunction = 'if x = 1 & y = 2 then write(&clock)'
    expect(textFor({ spec, source: conjunction, group: 'constant.builtin' })).toEqual(['&clock'])
    expect(textFor({ spec, source: conjunction, group: 'operator' })).toEqual(['=', '&', '='])
  })

  it('leaves a conjunction flush against a name uncoloured rather than guessing', () => {
    expectPlain({ spec, source: 'if lo &hi then write(1)', text: '&hi' })
  })

  it('keeps a prefix operator off an ampersand keyword that follows it', () => {
    const generated = 'every writes(!&lcase | ?&digits | \\&null)'
    expect(textFor({ spec, source: generated, group: 'constant.builtin' })).toEqual([
      '&lcase',
      '&digits',
      '&null',
    ])
  })

  it('reads both quoted forms as strings, cset literals included', () => {
    expect(textFor({ spec, source, group: 'string' })).toEqual([
      '"result"',
      '": "',
      '"multiply: "',
      '"calls: "',
      '" at "',
      '"cs101"',
      "'0123456789'",
      '"no name"',
    ])
  })

  it('reads the unary and alternation operators', () => {
    expect(textFor({ spec, source: 'x := \\y | !z ? "a" || "b"', group: 'operator' })).toEqual([
      ':=',
      '\\',
      '|',
      '!',
      '?',
      '||',
    ])
  })

  it('reads a preprocessor directive only at the head of a line', () => {
    expect(textFor({ spec, source, group: 'keyword.directive' })).toEqual(['$define'])
    expect(groupsIn({ spec, source: 'x := y $define' })).not.toContain('keyword.directive')
  })

  it('reads a radix literal as one number and leaves a name after a digit alone', () => {
    expect(textFor({ spec, source: 'mask := 16rFF + 2r1101 + 3.5e2', group: 'number' })).toEqual([
      '16rFF',
      '2r1101',
      '3.5e2',
    ])
    expect(textFor({ spec, source: 'n := 1_000', group: 'number' })).toEqual(['1'])
  })

  it('reads a record field as a member, not as the builtin it is named after', () => {
    expect(textFor({ spec, source, group: 'variable.member' })).toEqual([
      'tally',
      'scale',
      'tally',
      'tally',
    ])
    const fields = 'write(node.key, node.type, node.image)'
    expect(textFor({ spec, source: fields, group: 'function.builtin' })).toEqual(['write'])
    expect(textFor({ spec, source: fields, group: 'variable.member' })).toEqual([
      'key',
      'type',
      'image',
    ])
  })

  it('reads declared procedures as calls and library procedures as builtins', () => {
    expect(textFor({ spec, source, group: 'function.builtin' })).toContain('writes')
    expect(textFor({ spec, source, group: 'function.call' })).toContain('multiply')
  })

  it('leaves a local whose name merely starts with a builtin alone', () => {
    expectPlain({ spec, source, text: 'keyname' })
  })

  it('answers to the icn alias too', () => {
    expect(spec.aliases).toContain('icn')
  })
})
