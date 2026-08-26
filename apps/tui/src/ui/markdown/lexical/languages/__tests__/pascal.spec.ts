import { describe, expect, it } from 'bun:test'

import { expectLexes, expectPlain, groupsIn, textFor } from '../../__tests__/harness'
import { pascal as spec } from '../pascal'

const source = [
  '{$mode objfpc}{$H+}',
  'program CalcDemo;',
  '',
  '{ A tiny calculator, in Object Pascal. }',
  '',
  'uses',
  '  SysUtils;',
  '',
  'type',
  '  TCalculator = class',
  '  private',
  '    FScale: Integer;',
  '  public',
  '    constructor Create(AScale: Integer);',
  '    function Multiply(X, Y: Integer): Integer;',
  '  end;',
  '',
  'const',
  '  Scales: array[1..3] of Integer = (1, 2, 4);',
  '  Mask = $FF;',
  '  Bell = #7;',
  '',
  'function Add(A, B: Integer): Integer;  // sum of two integers',
  'begin',
  '  Result := A + B;',
  'end;',
  '',
  'constructor TCalculator.Create(AScale: Integer);',
  'begin',
  '  FScale := AScale;',
  'end;',
  '',
  'function TCalculator.Multiply(X, Y: Integer): Integer;',
  'var',
  '  Divisor: Integer;',
  'begin',
  '  Divisor := 1;',
  '  if (X = 0) or (Y = 0) then',
  '    Result := 0',
  '  else',
  '    Result := X * Y * FScale div Divisor;',
  'end;',
  '',
  '(* Entry point. *)',
  'var',
  '  Calc: TCalculator;',
  '  Verbose: Boolean = True;',
  'begin',
  '  Calc := TCalculator.Create(2);',
  '  if Verbose then',
  "    WriteLn('It''s ', Add(2, 3), ' and ', Calc.Multiply(5, 3));",
  '  Calc.Free;',
  'end.',
  '',
].join('\n')

describe('pascal lexical highlighting', () => {
  it('lexes a representative sample', () => {
    expectLexes({
      spec,
      source,
      groups: [
        'keyword.directive',
        'comment',
        'string',
        'keyword',
        'type',
        'number',
        'character',
        'operator',
        'constant.builtin',
        'function.builtin',
        'function.call',
      ],
    })
  })

  it('reads the colon-equals assignment as a single operator', () => {
    expect(textFor({ spec, source: 'Result := A + B;', group: 'operator' })).toEqual([':=', '+'])
  })

  it('keeps a bare colon out of the operators', () => {
    expectPlain({ spec, source: '  Divisor: Integer;', text: ':' })
  })

  it('reads the address-of sigil as an operator', () => {
    expect(textFor({ spec, source: 'Handler := @Report;', group: 'operator' })).toEqual([':=', '@'])
  })

  it('reads the pointer caret as an operator', () => {
    expect(textFor({ spec, source: 'Total := Node^.Value;', group: 'operator' })).toEqual([
      ':=',
      '^',
    ])
  })

  it('reads binary and octal literals whole', () => {
    expect(textFor({ spec, source: 'Flags := %1010 or &777;', group: 'number' })).toEqual([
      '%1010',
      '&777',
    ])
  })

  it('leaves a property that shares a standard type name alone', () => {
    expectPlain({ spec, source: 'Edit1.Text := Trim(Caption);', text: 'Text' })
  })

  it('reads uppercase keywords as keywords', () => {
    expect(textFor({ spec, source: 'PROCEDURE Nudge; BEGIN Halt END;', group: 'keyword' })).toEqual([
      'PROCEDURE',
      'BEGIN',
      'END',
    ])
  })

  it('reads a mixed-case type name as a type', () => {
    expect(textFor({ spec, source: 'Verbose: Boolean = True;', group: 'type' })).toEqual(['Boolean'])
  })

  it('reads a doubled quote as part of the string', () => {
    expect(textFor({ spec, source, group: 'string' })).toEqual(["'It''s '", "' and '"])
  })

  it('reads all three comment forms', () => {
    expect(textFor({ spec, source, group: 'comment' })).toEqual([
      '{ A tiny calculator, in Object Pascal. }',
      '// sum of two integers',
      '(* Entry point. *)',
    ])
  })

  it('reads a compiler directive apart from a brace comment', () => {
    expect(textFor({ spec, source, group: 'keyword.directive' })).toEqual([
      '{$mode objfpc}',
      '{$H+}',
    ])
  })

  it('reads dollar hex and hash character literals', () => {
    expect(textFor({ spec, source, group: 'character' })).toEqual(['#7'])
    expect(textFor({ spec, source: 'Mask = $FF;', group: 'number' })).toEqual(['$FF'])
  })

  it('leaves an identifier that merely starts with a keyword alone', () => {
    expectPlain({ spec, source, text: 'Divisor' })
    expect(groupsIn({ spec, source: 'Divisor' }).size).toBe(0)
  })

  it('answers to the pas alias too', () => {
    expect(spec.aliases).toContain('pas')
  })
})
