import { describe, expect, it } from 'bun:test'

import { expectLexes, expectPlain, groupsIn, textFor } from '../../__tests__/harness'
import { matlab as spec } from '../matlab'

const source = [
  '%{',
  '  Calculator: a scaled add and multiply, with a printed demo.',
  '%}',
  '',
  'classdef Calculator',
  '    properties',
  '        Scale = 1',
  '    end',
  '',
  '    methods',
  '        function obj = Calculator(scale)',
  '            obj.Scale = scale;',
  '        end',
  '',
  '        function total = add(obj, a, b)',
  '            total = obj.Scale * (a + b);',
  '        end',
  '',
  '        function out = multiply(obj, x, y)',
  '            out = obj.Scale * x * y;',
  '        end',
  '',
  '        function report(obj)',
  '            weights = ones(1, 3);',
  '            values = linspace(0, 1, 3);',
  "            v = values' * weights;",
  '            % guard against a broken adder',
  '            if isempty(v) || obj.add(1, 2) ~= 3 * obj.Scale',
  "                error('add is broken');",
  '            end',
  '            name = "Calculator";',
  "            fprintf('%s: %d\\n', name, obj.multiply(5, 3) + ...",
  '                obj.add(1, 2));',
  '            op = @sin;',
  '            disp(op(pi) + numel(v));',
  '        end',
  '    end',
  'end',
  '',
].join('\n')

const inlineBrace = ['x = 5;  %{ not a block opener', 'y = 6;', 'z = 7;'].join('\n')
const indentedBlock = ['    %{', '    hidden = 1;', '    %}', 'shown = 2;'].join('\n')
const transposeChain = "y = A' * B.' + C'';"
const transposedString = `s = "abc"' + 'x';`
const percentInCharArray = "fprintf('100%% done\\n');"

describe('matlab lexical highlighting', () => {
  it('lexes a representative sample', () => {
    expectLexes({
      spec,
      source,
      groups: [
        'comment',
        'string',
        'keyword',
        'number',
        'operator',
        'function',
        'function.call',
        'function.builtin',
        'constant.builtin',
      ],
    })
  })

  it('reads the percent-brace block, the percent line and the continuation as comments', () => {
    expect(textFor({ spec, source, group: 'comment' })).toEqual([
      '%{\n  Calculator: a scaled add and multiply, with a printed demo.\n%}',
      '% guard against a broken adder',
      '...',
    ])
  })

  it('opens a percent-brace block under leading whitespace', () => {
    expect(textFor({ spec, source: indentedBlock, group: 'comment' })).toEqual([
      '%{\n    hidden = 1;\n    %}',
    ])
  })

  it('treats a percent-brace that trails code as an ordinary line comment', () => {
    expect(textFor({ spec, source: inlineBrace, group: 'comment' })).toEqual([
      '%{ not a block opener',
    ])
    expect(textFor({ spec, source: inlineBrace, group: 'number' })).toEqual(['5', '6', '7'])
  })

  it('reads char arrays and double-quoted strings without swallowing the transpose', () => {
    expect(textFor({ spec, source, group: 'string' })).toEqual([
      "'add is broken'",
      '"Calculator"',
      "'%s: %d\\n'",
    ])
  })

  it('reads a transpose chain as operators and never as a string', () => {
    expect(textFor({ spec, source: transposeChain, group: 'operator' })).toEqual([
      '=',
      "'",
      '*',
      "'",
      '+',
      "''",
    ])
    expect(groupsIn({ spec, source: transposeChain })).not.toContain('string')
  })

  it('refuses a char array whose tick transposes a double-quoted string', () => {
    expect(textFor({ spec, source: transposedString, group: 'string' })).toEqual(['"abc"', "'x'"])
  })

  it('reads a doubled tick as an escape inside a char array', () => {
    expect(textFor({ spec, source: "msg = 'it''s fine';", group: 'string' })).toEqual([
      "'it''s fine'",
    ])
  })

  it('reads a doubled quote as an escape inside a string', () => {
    expect(textFor({ spec, source: 's = "say ""hi""";', group: 'string' })).toEqual([
      '"say ""hi"""',
    ])
  })

  it('keeps a percent conversion inside a char array out of the comment rule', () => {
    expect(textFor({ spec, source: percentInCharArray, group: 'string' })).toEqual([
      "'100%% done\\n'",
    ])
    expect(groupsIn({ spec, source: percentInCharArray })).not.toContain('comment')
  })

  it('reads a named function handle as a function', () => {
    expect(textFor({ spec, source, group: 'function' })).toEqual(['@sin'])
  })

  it('reads an imaginary literal as one number', () => {
    expect(textFor({ spec, source: 'z = 3 + 4i;', group: 'number' })).toEqual(['3', '4i'])
  })

  it('reads a leading-dot literal whole and leaves the element-wise divide alone', () => {
    expect(textFor({ spec, source: 'p = .5 * q;', group: 'number' })).toEqual(['.5'])
    expect(textFor({ spec, source: 'r = 1./x;', group: 'number' })).toEqual(['1'])
  })

  it('reads the colon and left-divide operators', () => {
    expect(textFor({ spec, source: 'w = A(2:end, :);', group: 'operator' })).toEqual(['=', ':', ':'])
    expect(textFor({ spec, source: 'x = A \\ b;', group: 'operator' })).toEqual(['=', '\\'])
  })

  it('leaves an uppercase-initial property name plain', () => {
    expectPlain({ spec, source, text: 'Scale = 1' })
  })

  it('leaves a name that is assigned rather than called plain', () => {
    expectPlain({ spec, source, text: 'weights = ones' })
  })

  it('answers to the m and octave aliases too', () => {
    expect(spec.aliases).toEqual(['m', 'octave'])
  })
})
