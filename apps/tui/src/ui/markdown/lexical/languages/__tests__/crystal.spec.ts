import { describe, expect, it } from 'bun:test'

import { expectLexes, expectPlain, groupsIn, textFor } from '../../__tests__/harness'
import { crystal as spec } from '../crystal'

const source = [
  '# a calculator, crystal-side',
  'require "big"',
  '',
  '@[Flags]',
  'enum Mode',
  '  Fast',
  '  Exact',
  'end',
  '',
  'def add(a : Int32, b : Int32) : Int32',
  '  a + b',
  'end',
  '',
  'class Calculator',
  '  LIMIT = 100_000',
  '  @@built = 0',
  '',
  '  getter scale : Int32',
  '  property? verbose = false',
  '',
  '  def initialize(@scale : Int32)',
  '    @@built += 1',
  '  end',
  '',
  '  def self.built : Int32',
  '    @@built',
  '  end',
  '',
  '  def multiply(x : Int32, y : Int32) : Int32',
  '    raise ArgumentError.new("scale too large") if @scale > Calculator::LIMIT',
  '    x * y * @scale',
  '  end',
  '',
  '  def ratio : Float64',
  '    @scale / 2.0_f64',
  '  end',
  '',
  '  def describe(mode : Symbol) : String',
  '    case mode',
  '    when :fast then "quick"',
  '    else "exact"',
  '    end',
  '  end',
  'end',
  '',
  'calc = Calculator.new(2)',
  'grade = \'A\'',
  'bullet = \'\\u2022\'',
  'puts "#{grade}#{bullet} #{calc.multiply(5, 3)}"',
  'puts add(2, 3)',
  '',
].join('\n')

describe('crystal lexical highlighting', () => {
  it('lexes a representative sample', () => {
    expectLexes({
      spec,
      source,
      groups: [
        'comment',
        'string',
        'character',
        'keyword',
        'type',
        'variable.member',
        'attribute',
        'punctuation',
        'string.special.symbol',
        'function.call',
        'function.builtin',
        'constant.builtin',
        'number',
        'operator',
      ],
    })
  })

  it('reads an annotation as an attribute', () => {
    expect(textFor({ spec, source, group: 'attribute' })).toEqual(['@[Flags]'])
  })

  it('reads instance and class variables as members', () => {
    expect(textFor({ spec, source, group: 'variable.member' })).toEqual([
      '@@built',
      '@scale',
      '@@built',
      '@@built',
      '@scale',
      '@scale',
      '@scale',
    ])
  })

  it('reads a single-quoted literal as a character, never a string', () => {
    expect(textFor({ spec, source, group: 'character' })).toEqual(["'A'", "'\\u2022'"])
    expect(textFor({ spec, source, group: 'string' })).not.toContain("'A'")
  })

  it('reads every crystal character escape whole', () => {
    const escapes = "a = '\\t'\nb = '\\''\nc = '\\u0041'\nd = '\\u{1F600}'"
    expect(textFor({ spec, source: escapes, group: 'character' })).toEqual([
      "'\\t'",
      "'\\''",
      "'\\u0041'",
      "'\\u{1F600}'",
    ])
  })

  it('reads a symbol as a symbol and a path separator as punctuation', () => {
    expect(textFor({ spec, source, group: 'string.special.symbol' })).toEqual([':fast'])
    expect(textFor({ spec, source, group: 'punctuation' })).toEqual(['::'])
  })

  it('keeps an interpolated string whole', () => {
    expect(textFor({ spec, source, group: 'string' })).toEqual([
      '"big"',
      '"scale too large"',
      '"quick"',
      '"exact"',
      '"#{grade}#{bullet} #{calc.multiply(5, 3)}"',
    ])
  })

  it('reads self and a boolean as builtin constants', () => {
    expect(textFor({ spec, source, group: 'constant.builtin' })).toEqual(['false', 'self'])
  })

  it('reads a declaration keyword crystal added to ruby', () => {
    expect(groupsIn({ spec, source: 'abstract struct Point\nend' })).toEqual(new Set(['keyword', 'type']))
  })

  it('reads the question-mark and bang macro forms as keywords', () => {
    const accessors = 'getter? valid : Bool\nproperty! name : String\ngetter! conn : DB'
    expect(textFor({ spec, source: accessors, group: 'keyword' })).toEqual([
      'getter?',
      'property!',
      'getter!',
    ])
  })

  it('reads a typed numeric literal whole, suffix included', () => {
    expect(textFor({ spec, source: 'n = 1_i64 + 2u8 * 1.5_f32 - 0xFF_i32', group: 'number' })).toEqual([
      '1_i64',
      '2u8',
      '1.5_f32',
      '0xFF_i32',
    ])
  })

  it('stops a numeric literal at a range operator', () => {
    expect(textFor({ spec, source: 'span = 1..5', group: 'number' })).toEqual(['1', '5'])
    expectPlain({ spec, source: 'span = 1..5', text: '..' })
  })

  it('reads a debug macro as a builtin', () => {
    expect(textFor({ spec, source: 'p! total\npp! calc', group: 'function.builtin' })).toEqual([
      'p!',
      'pp!',
    ])
  })

  it('leaves the colon of a type restriction alone', () => {
    expectPlain({ spec, source, text: ': Int32' })
  })

  it('leaves an ordinary local alone', () => {
    expectPlain({ spec, source, text: 'calc =' })
  })

  it('does not find a keyword inside a longer name', () => {
    expect(groupsIn({ spec, source: 'ended = extended_scale' })).toEqual(new Set(['operator']))
  })

  it('answers to the cr alias too', () => {
    expect(spec.aliases).toContain('cr')
  })
})
