import { describe, expect, it } from 'bun:test'

import { expectLexes, expectPlain, groupsIn, textFor } from '../../__tests__/harness'
import { erlang as spec } from '../erlang'

const source = [
  '%% calculator.erl -- a small module',
  '-module(calculator).',
  '-moduledoc "A tiny calculator.".',
  '-export([add/2, multiply/2, kind/1, main/0]).',
  '',
  '-define(SCALE, 2).',
  '',
  '-record(state, {type = decimal, total = 0 :: integer()}).',
  '',
  '-doc """',
  'Adds two numbers and returns their sum.',
  '""".',
  '-spec add(integer(), integer()) -> integer().',
  'add(X, Y) ->',
  '    X + Y.',
  '',
  'multiply(X, Y) when is_integer(X), is_integer(Y) ->',
  '    X * Y * ?SCALE;',
  'multiply(_, _) ->',
  '    {error, not_found}.',
  '',
  'kind(S) ->',
  '    S#state.type.',
  '',
  'scale(Values) ->',
  '    Double = fun(V) -> V * 2 end,',
  '    Mask = 16#ff band 2#1010,',
  '    Halves = [V div 2 || V <- Values, V rem 2 =:= 0, V < Mask],',
  '    begin',
  '        lists:map(Double, Halves)',
  '    end.',
  '',
  'main() ->',
  '    Sum = add(2, 3),',
  '    Product = multiply(5, 3),',
  '    Numeric = is_integer(Sum) or is_float(Sum),',
  '    Positive = Numeric and (Sum > 0),',
  '    Label = \'the answer\',',
  '    Initial = $c,',
  '    case Positive andalso not (Sum =:= Product) of',
  '        true -> io:format("~c ~s ~p~n", [Initial, Label, Sum]);',
  '        false -> io:format("~p~n", [Product])',
  '    end,',
  '    receive',
  '        {tally, From} -> From ! {ok, Sum}',
  '    after 1000 ->',
  '        timeout',
  '    end,',
  '    try lists:nth(1, scale([2, 4])) of',
  '        First -> First',
  '    catch',
  '        _:_ -> undefined',
  '    end.',
  '',
].join('\n')

describe('erlang lexical highlighting', () => {
  it('lexes a representative sample', () => {
    expectLexes({
      spec,
      source,
      groups: [
        'comment',
        'string',
        'keyword',
        'keyword.directive',
        'constant.builtin',
        'constant.macro',
        'character',
        'type',
        'variable',
        'module',
        'function.call',
        'function.builtin',
        'number',
        'operator',
      ],
    })
  })

  it('reads an uppercase-initial name as a variable, never a type', () => {
    const clause = 'add(X, Y) ->\n    X + Y.'
    expect(textFor({ spec, source: clause, group: 'variable' })).toEqual(['X', 'Y', 'X', 'Y'])
    expect(groupsIn({ spec, source: clause })).not.toContain('type')
  })

  it('reads a leading-hyphen module attribute as a directive', () => {
    expect(textFor({ spec, source, group: 'keyword.directive' })).toEqual([
      '-module',
      '-moduledoc',
      '-export',
      '-define',
      '-record',
      '-doc',
      '-spec',
    ])
  })

  it('anchors the directive to the head of a line', () => {
    expect(textFor({ spec, source: 'Y = X - abs(X),', group: 'keyword.directive' })).toEqual([])
  })

  it('reads a macro reference and a character literal', () => {
    expect(textFor({ spec, source, group: 'constant.macro' })).toEqual(['?SCALE'])
    expect(textFor({ spec, source, group: 'character' })).toEqual(['$c'])
  })

  it('splits a remote call into module and function', () => {
    const call = 'io:format("hi~n", []).'
    expect(textFor({ spec, source: call, group: 'module' })).toEqual(['io'])
    expect(textFor({ spec, source: call, group: 'function.call' })).toEqual(['format'])
  })

  it('reads an exact-equality operator as one run', () => {
    expect(textFor({ spec, source: 'X =:= Y', group: 'operator' })).toEqual(['=:='])
  })

  it('reads quoted atoms and every string form as strings', () => {
    expect(textFor({ spec, source, group: 'string' })).toEqual([
      '"A tiny calculator."',
      '"""\nAdds two numbers and returns their sum.\n"""',
      "'the answer'",
      '"~c ~s ~p~n"',
      '"~p~n"',
    ])
  })

  it('closes a triple-quoted doc string instead of letting the one-quote form run away', () => {
    const doc = '-doc """\nAdds two numbers.\n""".\nadd(X, Y) -> X + Y.'
    expect(textFor({ spec, source: doc, group: 'string' })).toEqual([
      '"""\nAdds two numbers.\n"""',
    ])
    expect(textFor({ spec, source: doc, group: 'variable' })).toEqual(['X', 'Y', 'X', 'Y'])
  })

  it('reads a backslash escape inside a quoted atom', () => {
    const line = "Label = 'don\\'t stop',"
    expect(textFor({ spec, source: line, group: 'string' })).toEqual(["'don\\'t stop'"])
  })

  it('reads the non-short-circuit boolean words as keywords', () => {
    expect(textFor({ spec, source: 'ok(A, B) -> A and B or not A.', group: 'keyword' })).toEqual([
      'and',
      'or',
      'not',
    ])
  })

  it('reads base-notation integers as numbers', () => {
    expect(textFor({ spec, source: 'Mask = 16#ff band 2#1010,', group: 'number' })).toEqual([
      '16#ff',
      '2#1010',
    ])
  })

  it('leaves an atom that merely opens with a keyword alone', () => {
    expectPlain({ spec, source, text: 'not_found' })
  })

  it('leaves a record field named after an attribute alone', () => {
    expectPlain({ spec, source, text: 'type = decimal' })
    expectPlain({ spec, source: 'kind(S) ->\n    S#state.type.', text: 'type.' })
  })

  it('answers to the erl alias too', () => {
    expect(spec.aliases).toContain('erl')
  })
})
