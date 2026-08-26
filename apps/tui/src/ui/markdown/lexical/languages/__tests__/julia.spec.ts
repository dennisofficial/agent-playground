import { describe, expect, it } from 'bun:test'

import { expectLexes, expectPlain, textFor } from '../../__tests__/harness'
import { julia as spec } from '../julia'

const source = [
  '#= a small calculator',
  '   #= it nests =#',
  '=#',
  'module Calc',
  '',
  'using Printf',
  '',
  'export add, multiply',
  '',
  'abstract type Scaled end',
  '',
  '"""',
  '    add(x, y)',
  '',
  'Add two integers.',
  '"""',
  'add(x::Int64, y::Int64)::Int64 = x + y',
  '',
  'mutable struct Calculator <: Scaled',
  '    scale::Float64',
  '    label::String',
  'end',
  '',
  'const DEFAULTS = Dict(:scale => 2.0, :label => "demo")',
  '',
  'function multiply(c::Calculator, x::Float64, y::Float64)',
  '    x == 0.0 && return 0.0  # nothing to multiply',
  '    return c.scale * x * y',
  'end',
  '',
  'function normalize!(values::Vector{Float64})',
  '    for i in eachindex(values)',
  '        values[i] = values[i] / 2.0',
  '    end',
  '    return values',
  'end',
  '',
  'function report(values::Vector{Float64})',
  '    best = -Inf',
  '    for v in sort(values)',
  '        best = max(best, v)',
  '    end',
  '    @printf("best %.2f in %s\\n", best, join(values, \',\'))',
  '    return best',
  'end',
  '',
  'end',
  '',
  'calc = Calc.Calculator(2.0, get(DEFAULTS, :label, nothing))',
  'Calc.normalize!([2.0, 4.0])',
  'println(Calc.add(2, 3), Calc.multiply(calc, 5.0, 3.0))',
  '',
].join('\n')

describe('julia lexical highlighting', () => {
  it('lexes a representative sample', () => {
    expectLexes({
      spec,
      source,
      groups: [
        'comment',
        'string',
        'keyword',
        'type',
        'number',
        'operator',
        'character',
        'function.call',
        'function.builtin',
        'function.macro',
        'constant.builtin',
        'string.special.symbol',
      ],
    })
  })

  it('reads a macro invocation as a macro', () => {
    expect(textFor({ spec, source, group: 'function.macro' })).toEqual(['@printf'])
  })

  it('reads a broadcast macro as a macro', () => {
    expect(textFor({ spec, source: '@. y = x + 1', group: 'function.macro' })).toEqual(['@.'])
  })

  it('reads a quoted name as a symbol', () => {
    expect(textFor({ spec, source, group: 'string.special.symbol' })).toEqual([
      ':scale',
      ':label',
      ':label',
    ])
  })

  it('closes a nesting block comment on its outermost delimiter', () => {
    expect(textFor({ spec, source, group: 'comment' })).toEqual([
      '#= a small calculator\n   #= it nests =#\n=#',
      '# nothing to multiply',
    ])
  })

  it('reads a docstring and a plain string as strings', () => {
    expect(textFor({ spec, source, group: 'string' })).toEqual([
      '"""\n    add(x, y)\n\nAdd two integers.\n"""',
      '"demo"',
      '"best %.2f in %s\\n"',
    ])
  })

  it('reads a character literal apart from a string', () => {
    expect(textFor({ spec, source, group: 'character' })).toEqual(["','"])
  })

  it('reads an escaped character literal whole', () => {
    expect(
      textFor({ spec, source: "nl = '\\n'; e = '\\u00e9'; b = '\\\\'", group: 'character' }),
    ).toEqual(["'\\n'", "'\\u00e9'", "'\\\\'"])
  })

  it('reads a bang-suffixed name whole', () => {
    expect(textFor({ spec, source: 'push!(xs, 1.0)', group: 'function.builtin' })).toEqual(['push!'])
  })

  it('keeps a bang out of an unspaced inequality', () => {
    expect(textFor({ spec, source: 'x!=y', group: 'operator' })).toEqual(['!='])
  })

  it('reads the annotation operator', () => {
    expect(textFor({ spec, source: 'total::Int64 = 3', group: 'operator' })).toEqual(['::', '='])
  })

  it('reads a capitalised name as a type', () => {
    expect(textFor({ spec, source: 'struct Point end', group: 'type' })).toEqual(['Point'])
  })

  it('reads the contextual type keyword', () => {
    expect(textFor({ spec, source: 'abstract type Shape end', group: 'keyword' })).toEqual([
      'abstract',
      'type',
      'end',
    ])
  })

  it('reads a float32 literal as one number', () => {
    expect(textFor({ spec, source: 'g = 1.5f0 * 3f0', group: 'number' })).toEqual(['1.5f0', '3f0'])
  })

  it('does not read a range bound as a symbol', () => {
    expectPlain({ spec, source: 'idx = xs[1:n]', text: 'n]' })
  })

  it('does not read a pair of transposes as a character', () => {
    expectPlain({ spec, source: "y = A' * B'", text: "' * " })
  })

  it('leaves an ordinary local alone', () => {
    expectPlain({ spec, source, text: 'scale::Float64' })
  })

  it('answers to the jl alias too', () => {
    expect(spec.aliases).toContain('jl')
  })
})
