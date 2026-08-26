import { describe, expect, it } from 'bun:test'

import { expectLexes, expectPlain, textFor } from '../../__tests__/harness'
import { ruby as spec } from '../ruby'

const source = [
  '# a calculator',
  'require "set"',
  '',
  'class Calculator',
  '  def initialize(scale)',
  '    @scale = scale',
  '    @@built += 1',
  '  end',
  '',
  '  def multiply(x, y)',
  '    return nil if x.nil?',
  "    raise ArgumentError, 'no' unless valid?(:pair)",
  '    x * y * @scale',
  '  end',
  'end',
  '',
  'puts Calculator.new(2).multiply(5, 3)',
  '',
].join('\n')

describe('ruby lexical highlighting', () => {
  it('lexes a representative sample', () => {
    expectLexes({
      spec,
      source,
      groups: [
        'comment',
        'string',
        'keyword',
        'type',
        'variable.member',
        'function.call',
        'function.builtin',
        'number',
        'constant.builtin',
        'string.special.symbol',
      ],
    })
  })

  it('reads instance and class variables as members', () => {
    expect(textFor({ spec, source, group: 'variable.member' })).toEqual([
      '@scale',
      '@@built',
      '@scale',
    ])
  })

  it('reads a constant-cased name as a type', () => {
    expect(textFor({ spec, source, group: 'type' })).toEqual([
      'Calculator',
      'ArgumentError',
      'Calculator',
    ])
  })

  it('reads a single-quoted string as a string', () => {
    expect(textFor({ spec, source, group: 'string' })).toEqual(['"set"', "'no'"])
  })

  it('leaves an ordinary local alone', () => {
    expectPlain({ spec, source, text: 'scale)' })
  })

  it('reads a trailing-punctuation method name whole', () => {
    expect(textFor({ spec, source: 'x.nil? && y', group: 'operator' })).toEqual(['&&'])
  })

  it('answers to the rb alias too', () => {
    expect(spec.aliases).toContain('rb')
  })
})
