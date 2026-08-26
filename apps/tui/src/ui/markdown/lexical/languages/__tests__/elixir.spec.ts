import { describe, expect, it } from 'bun:test'

import { expectLexes, expectPlain, textFor } from '../../__tests__/harness'
import { elixir as spec } from '../elixir'

const source = [
  '# a calculator',
  'defmodule Calculator do',
  '  @moduledoc """',
  '  Scales a product.',
  '  """',
  '',
  '  defstruct scale: 1',
  '',
  '  @doc ~S"""',
  '  Adds `x` and `y`. An escape like #{sum} stays literal.',
  '  """',
  '  @spec add(number, number) :: number',
  '  def add(x, y), do: x + y',
  '',
  '  def multiply(%Calculator{scale: scale}, x, y) when is_number(x) do',
  '    x * y * scale',
  '  end',
  '',
  '  defp fail(pair), do: raise(ArgumentError, message: "bad #{pair}")',
  '',
  '  def describe(value) do',
  '    case value do',
  '      :pair -> "a pair"',
  '      nil -> fail(value)',
  '      other when is_binary(other) -> ~s(a string)',
  '    end',
  '  end',
  '',
  '  def vowel?(<<char::utf8, _rest::binary>>), do: char == ?a',
  'end',
  '',
  'matcher = ~r/^al(pha)?$/i',
  'names = ~w[alpha beta]',
  '',
  'names',
  '|> Enum.filter(&Regex.match?(matcher, &1))',
  '|> Enum.each(fn name -> IO.puts("hello #{name}") end)',
  '',
  '{:ok, doc} = File.read("mix.exs")',
  'IO.puts(byte_size(doc))',
  '',
  'IO.puts(Calculator.add(2, 3))',
  'IO.puts(Calculator.multiply(%Calculator{scale: 2}, 5, 3))',
  '',
].join('\n')

describe('elixir lexical highlighting', () => {
  it('lexes a representative sample', () => {
    expectLexes({
      spec,
      source,
      groups: [
        'comment',
        'string',
        'keyword',
        'module',
        'attribute',
        'function.call',
        'function.builtin',
        'number',
        'constant.builtin',
        'string.special.symbol',
        'string.special.key',
        'character',
        'operator',
      ],
    })
  })

  it('reads sigils as strings', () => {
    expect(
      textFor({ spec, source: 'parts = ~w[a b] ++ ~s(c) ++ [~r/^a$/i]', group: 'string' }),
    ).toEqual(['~w[a b]', '~s(c)', '~r/^a$/i'])
  })

  it('reads a sigil past an escaped delimiter', () => {
    expect(
      textFor({ spec, source: 'slashed = ~r/a\\/b/ <> "tail"', group: 'string' }),
    ).toEqual(['~r/a\\/b/', '"tail"'])
  })

  it('takes a heredoc sigil whole instead of stopping at its second quote', () => {
    const heredoc = ['@doc ~S"""', 'Raw #{x} text.', '"""', 'def f(x), do: x'].join('\n')
    expect(textFor({ spec, source: heredoc, group: 'string' })).toEqual([
      '~S"""\nRaw #{x} text.\n"""',
    ])
    expect(textFor({ spec, source: heredoc, group: 'keyword' })).toEqual(['def'])
  })

  it('takes a charlist heredoc whole instead of as an empty charlist', () => {
    const heredoc = ["chars = '''", 'a b', "'''", 'more = 1'].join('\n')
    expect(textFor({ spec, source: heredoc, group: 'string' })).toEqual(["'''\na b\n'''"])
    expect(textFor({ spec, source: heredoc, group: 'number' })).toEqual(['1'])
  })

  it('never mistakes an interpolation for a comment', () => {
    expect(textFor({ spec, source, group: 'comment' })).toEqual(['# a calculator'])
  })

  it('reads atoms and quoted atoms as symbols', () => {
    expect(textFor({ spec, source, group: 'string.special.symbol' })).toEqual([':pair', ':ok'])
    expect(textFor({ spec, source: '{:ok, :"two words"}', group: 'string.special.symbol' })).toEqual(
      [':ok', ':"two words"'],
    )
  })

  it('reads keyword-list labels as keys', () => {
    expect(textFor({ spec, source, group: 'string.special.key' })).toEqual([
      'scale:',
      'do:',
      'scale:',
      'do:',
      'message:',
      'do:',
      'scale:',
    ])
  })

  it('reads module attributes as attributes', () => {
    expect(textFor({ spec, source, group: 'attribute' })).toEqual(['@moduledoc', '@doc', '@spec'])
  })

  it('reads uppercase-initial names as modules, not types', () => {
    expect(textFor({ spec, source, group: 'module' })).toEqual([
      'Calculator',
      'Calculator',
      'ArgumentError',
      'Enum',
      'Regex',
      'Enum',
      'IO',
      'File',
      'IO',
      'IO',
      'Calculator',
      'IO',
      'Calculator',
      'Calculator',
    ])
  })

  it('reads the pipe as an operator', () => {
    expect(textFor({ spec, source: 'total |> Enum.sum()', group: 'operator' })).toEqual(['|>'])
  })

  it('reads a type annotation as an operator rather than an atom', () => {
    expect(textFor({ spec, source: 'x :: binary', group: 'operator' })).toEqual(['::'])
    expect(textFor({ spec, source: 'x :: binary', group: 'string.special.symbol' })).toEqual([])
  })

  it('does not read a binary spec as a keyword label', () => {
    const binary = '<<char::utf8, rest::binary>>'
    expect(textFor({ spec, source: binary, group: 'string.special.key' })).toEqual([])
    expect(textFor({ spec, source: binary, group: 'string.special.symbol' })).toEqual([])
  })

  it('leaves a binary segment type uncoloured', () => {
    expectPlain({ spec, source, text: 'utf8' })
  })

  it('reads only the real character literal as a character', () => {
    expect(textFor({ spec, source, group: 'character' })).toEqual(['?a'])
  })

  it('keeps a trailing question mark inside the function name', () => {
    expect(textFor({ spec, source, group: 'function.call' })).toContain('vowel?')
  })

  it('leaves an ordinary local alone', () => {
    expectPlain({ spec, source, text: 'scale}' })
  })

  it('answers to the ex and exs aliases', () => {
    expect(spec.aliases).toEqual(['ex', 'exs'])
  })
})
