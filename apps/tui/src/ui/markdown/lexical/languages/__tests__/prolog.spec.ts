import { describe, expect, it } from 'bun:test'

import { expectLexes, expectPlain, groupsIn, textFor } from '../../__tests__/harness'
import { prolog as spec } from '../prolog'

const source = [
  '% a calculator',
  ':- module(calculator, [add/3, multiply/3]).',
  ':- use_module(library(lists)).',
  '',
  '/* the scale factor multiplies every',
  '   product this module reports */',
  ':- dynamic scale/1.',
  'scale(2).',
  '',
  'modes([modulo, division, truncation]).',
  "zero_char(0'0).",
  "label('it''s scaled').",
  '',
  'add(X, Y, Sum) :-',
  '    Sum is X + Y.',
  '',
  'multiply(_, 0, 0) :- !.',
  'multiply(X, Y, Product) :-',
  '    Y > 0,',
  '    scale(S),',
  '    Product is X * Y * S.',
  '',
  'mask(Bits, Masked) :-',
  "    Masked is Bits /\\ 16'FF \\/ 2'1010.",
  '',
  'is_valid(X) :- number(X), X > 0.',
  'is_valid(_) :- fail.',
  '',
  'total(Values, Total) :-',
  '    findall(V, member(V, Values), Vs),',
  '    sum_list(Vs, Total).',
  '',
  'greeting --> [hello], name.',
  'name --> [world].',
  '',
  ':- initialization(main, main).',
  '',
  'main :-',
  '    add(2, 3, Sum),',
  '    multiply(5, 3, Product),',
  '    format("~w ~w~n", [Sum, Product]).',
  '',
  '?- forall(between(1, 3, N), (multiply(N, 2, P), writeln(P))).',
  '',
].join('\n')

describe('prolog lexical highlighting', () => {
  it('lexes a representative sample', () => {
    expectLexes({
      spec,
      source,
      groups: [
        'comment',
        'keyword',
        'string',
        'character',
        'variable',
        'number',
        'operator',
        'function.call',
        'function.builtin',
        'constant.builtin',
      ],
    })
  })

  it('reads the clause neck of a rule as a keyword', () => {
    expect(textFor({ spec, source: 'foo(X) :- bar(X).', group: 'keyword' })).toEqual([':-'])
    expect(textFor({ spec, source: 'foo(X) :- bar(X).', group: 'function.call' })).toEqual([
      'foo',
      'bar',
    ])
  })

  it('reads a query neck and a DCG arrow as keywords', () => {
    expect(textFor({ spec, source: '?- add(1, 2, S).', group: 'keyword' })).toEqual(['?-'])
    expect(textFor({ spec, source: 'greeting --> [hello], name.', group: 'keyword' })).toEqual([
      '-->',
    ])
  })

  it('reads a directive functor as a keyword, not a call', () => {
    expect(textFor({ spec, source: ':- module(calculator, [add/3]).', group: 'keyword' })).toEqual([
      ':-',
      'module',
    ])
  })

  it('reads the cut as a keyword', () => {
    expect(textFor({ spec, source: 'multiply(_, 0, 0) :- !.', group: 'keyword' })).toEqual([
      ':-',
      '!',
    ])
  })

  it('reads uppercase-initial names and a bare underscore as variables', () => {
    expect(
      textFor({ spec, source: 'add(X, Y, Sum) :-\n    Sum is X + Y.', group: 'variable' }),
    ).toEqual(['X', 'Y', 'Sum', 'Sum', 'X', 'Y'])
    expect(textFor({ spec, source: 'first([H|_], H).', group: 'variable' })).toEqual(['H', '_', 'H'])
  })

  it('reads a character-code literal whole', () => {
    expect(textFor({ spec, source: "zero_char(0'0).", group: 'character' })).toEqual(["0'0"])
    expect(groupsIn({ spec, source: "zero_char(0'0)." })).not.toContain('string')
  })

  it('reads a radix-quoted integer as a number and leaks no string', () => {
    const line = "masked(M) :- M is 16'FF \\/ 2'1010."
    expect(textFor({ spec, source: line, group: 'number' })).toEqual(["16'FF", "2'1010"])
    expect(groupsIn({ spec, source: line })).not.toContain('string')
  })

  it('keeps integer division out of the block comment', () => {
    const line = 'half(X, Y) :- Y is X // 2.'
    expect(textFor({ spec, source: line, group: 'comment' })).toEqual([])
    expect(textFor({ spec, source: line, group: 'operator' })).toEqual(['//'])
  })

  it('reads the list-tail bar as an operator', () => {
    expect(textFor({ spec, source: 'first([H|T], H, T).', group: 'operator' })).toEqual(['|'])
  })

  it('reads a quoted atom with a doubled quote as one string', () => {
    expect(textFor({ spec, source, group: 'string' })).toEqual([
      "'it''s scaled'",
      '"~w ~w~n"',
    ])
  })

  it('consumes an atom whole before looking up keywords', () => {
    expect(textFor({ spec, source: 'is_valid(X) :- number(X).', group: 'function.call' })).toEqual([
      'is_valid',
      'number',
    ])
    expect(textFor({ spec, source: 'is_valid(X) :- number(X).', group: 'keyword' })).toEqual([':-'])
  })

  it('leaves a bare atom that merely starts with a keyword alone', () => {
    expectPlain({ spec, source, text: 'modulo' })
    expectPlain({ spec, source, text: 'division' })
  })

  it('leaves a paren-less nonterminal alone instead of calling it', () => {
    expectPlain({ spec, source, text: 'name.' })
  })

  it('answers to the pl and pro aliases too', () => {
    expect(spec.aliases).toEqual(['pl', 'pro'])
  })
})
