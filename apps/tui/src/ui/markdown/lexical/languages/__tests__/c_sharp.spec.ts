import { describe, expect, it } from 'bun:test'

import { expectLexes, expectPlain, groupsIn, textFor } from '../../__tests__/harness'
import { cSharp as spec } from '../c_sharp'

const source = [
  '// a calculator',
  'using System;',
  'using System.Collections.Generic;',
  'using System.Threading.Tasks;',
  '',
  '#nullable enable',
  '',
  'namespace Atlas.Samples;',
  '',
  '[Serializable]',
  'public sealed class Calculator',
  '{',
  '    private const string Label = @"c:\\calc";',
  '',
  '    private readonly double _scale;',
  '',
  '    public Calculator(double scale) => this._scale = scale;',
  '',
  '    #region arithmetic',
  '',
  '    public static int Add(int x, int y) => x + y;',
  '',
  '    public double Multiply(double x, double y)',
  '    {',
  '        if (y == 0.0) return 0.0;',
  '        return x * y * this._scale;',
  '    }',
  '',
  '    public double? Divide(double x, double y) => y == 0.0 ? null : x / y;',
  '',
  '    #endregion',
  '',
  '    public override string ToString() => $"{Label} x{_scale}";',
  '',
  '    public static async Task<List<char>> InitialsAsync()',
  '    {',
  '        await Task.Yield();',
  "        return new List<char> { 'a', 'b' };",
  '    }',
  '}',
  '',
  'internal static class Program',
  '{',
  '    private static void Main()',
  '    {',
  '        var calc = new Calculator(2.5);',
  '        var values = new List<double> { 1.0, 2.0 };',
  '        var index = 0;',
  '        Console.WriteLine($"sum {Calculator.Add(2, 3)}");',
  '        Console.WriteLine(calc.Multiply(values[index], 3.0));',
  '    }',
  '}',
  '',
].join('\n')

describe('c_sharp lexical highlighting', () => {
  it('lexes a representative sample', () => {
    expectLexes({
      spec,
      source,
      groups: [
        'comment',
        'keyword',
        'storageclass',
        'type.qualifier',
        'type.builtin',
        'type',
        'function.call',
        'string',
        'character',
        'attribute',
        'keyword.directive',
        'constant.builtin',
        'variable.builtin',
        'number',
        'operator',
      ],
    })
  })

  it('reads a verbatim string as one string, backslash and all', () => {
    expect(textFor({ spec, source, group: 'string' })).toEqual([
      '@"c:\\calc"',
      '$"{Label} x{_scale}"',
      '$"sum {Calculator.Add(2, 3)}"',
    ])
  })

  it('reads a doubled quote inside a verbatim string as content', () => {
    const verbatim = 'var quip = @"she said ""hi"" twice"; var next = 1;'
    expect(textFor({ spec, source: verbatim, group: 'string' })).toEqual([
      '@"she said ""hi"" twice"',
    ])
    expect(textFor({ spec, source: verbatim, group: 'number' })).toEqual(['1'])
  })

  it('reads an attribute at the head of a declaration', () => {
    expect(textFor({ spec, source, group: 'attribute' })).toEqual(['[Serializable]'])
  })

  it('reads an attribute that carries arguments', () => {
    expect(
      textFor({ spec, source: '[Obsolete("use Add")]\nint x;', group: 'attribute' }),
    ).toEqual(['[Obsolete("use Add")]'])
  })

  it('reads an attribute whose argument nests its own parentheses', () => {
    const nested = '[JsonConverter(typeof(StringEnumConverter))]\npublic int Kind;'
    expect(textFor({ spec, source: nested, group: 'attribute' })).toEqual([
      '[JsonConverter(typeof(StringEnumConverter))]',
    ])
  })

  it('reads a targeted attribute and a comma-separated list whole', () => {
    expect(
      textFor({ spec, source: '[assembly: AssemblyVersion("1.0.0")]', group: 'attribute' }),
    ).toEqual(['[assembly: AssemblyVersion("1.0.0")]'])
    expect(
      textFor({ spec, source: '[Serializable, Obsolete("no")]\nint x;', group: 'attribute' }),
    ).toEqual(['[Serializable, Obsolete("no")]'])
  })

  it('reads a raw string literal as one string in every interpolation form', () => {
    expect(textFor({ spec, source: 'var a = """line one""";', group: 'string' })).toEqual([
      '"""line one"""',
    ])
    expect(textFor({ spec, source: 'var b = $"""said {name}""";', group: 'string' })).toEqual([
      '$"""said {name}"""',
    ])
    expect(textFor({ spec, source: 'var c = $$"""{{x}} literal""";', group: 'string' })).toEqual([
      '$$"""{{x}} literal"""',
    ])
  })

  it('reads an at-escaped identifier as a variable rather than a keyword', () => {
    const escaped = 'var @class = 1;\nvar next = @class;'
    expect(textFor({ spec, source: escaped, group: 'variable' })).toEqual(['@class', '@class'])
    expect(textFor({ spec, source: escaped, group: 'keyword' })).toEqual(['var', 'var'])
  })

  it('reads preprocessor directives as directives', () => {
    expect(textFor({ spec, source, group: 'keyword.directive' })).toEqual([
      '#nullable',
      '#region',
      '#endregion',
    ])
  })

  it('reads char literals apart from strings', () => {
    expect(textFor({ spec, source, group: 'character' })).toEqual(["'a'", "'b'"])
  })

  it('reads a pascal-case receiver as a type and its member as a call', () => {
    const call = 'Console.WriteLine(calc.Multiply(5, 3));'
    expect(textFor({ spec, source: call, group: 'type' })).toEqual(['Console'])
    expect(textFor({ spec, source: call, group: 'function.call' })).toEqual([
      'WriteLine',
      'Multiply',
    ])
  })

  it('reads literal suffixes as part of the number', () => {
    expect(textFor({ spec, source: 'var big = 1_000L + 2.5f * 0.1m;', group: 'number' })).toEqual([
      '1_000L',
      '2.5f',
      '0.1m',
    ])
  })

  it('reads modifiers apart from plain keywords', () => {
    expect(textFor({ spec, source, group: 'storageclass' })).toEqual([
      'sealed',
      'static',
      'override',
      'static',
      'async',
      'static',
      'static',
    ])
    expect(textFor({ spec, source, group: 'type.qualifier' })).toEqual(['const', 'readonly'])
  })

  it('reads this as a builtin variable', () => {
    expect(textFor({ spec, source, group: 'variable.builtin' })).toEqual(['this', 'this'])
  })

  it('leaves an indexer alone rather than reading it as an attribute', () => {
    expectPlain({ spec, source, text: '[index]' })
  })

  it('leaves a line-leading collection expression alone', () => {
    const collection = 'int[] one =\n    [value];'
    expectPlain({ spec, source: collection, text: '[value]' })
  })

  it('leaves a private field alone', () => {
    expectPlain({ spec, source, text: '_scale;' })
  })

  it('keeps a line comment out of the string rules', () => {
    expect(groupsIn({ spec, source: '// a "quoted" aside' })).toEqual(new Set(['comment']))
  })

  it('answers to every spelling a fence might carry', () => {
    expect(spec.aliases).toEqual(['csharp', 'cs', 'c#'])
  })
})
