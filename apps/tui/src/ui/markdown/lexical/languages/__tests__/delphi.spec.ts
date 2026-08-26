import { describe, expect, it } from 'bun:test'

import { expectLexes, expectPlain, groupsIn, textFor } from '../../__tests__/harness'
import { delphi as spec } from '../delphi'

const source = [
  'program Calc;',
  '',
  '{$APPTYPE CONSOLE}',
  '',
  'uses',
  '  System.SysUtils, System.Classes;',
  '',
  'const',
  "  Root = 'C:\\Temp\\';",
  '',
  'type',
  '  TCalculator = class',
  '  private',
  '    FScale: Integer;',
  '  public',
  '    constructor Create(AScale: Integer);',
  '    function Multiply(X, Y: Integer): Integer;',
  '    property Scale: Integer read FScale write FScale;',
  '  end;',
  '',
  'function Add(A, B: Integer): Integer;',
  'begin',
  '  Result := A + B;',
  'end;',
  '',
  'constructor TCalculator.Create(AScale: Integer);',
  'begin',
  '  inherited Create;',
  '  FScale := AScale;',
  'end;',
  '',
  'function TCalculator.Multiply(X, Y: Integer): Integer;',
  'begin',
  '  Result := X * Y * FScale;   { scaled product }',
  'end;',
  '',
  'var',
  '  Calculator: TCalculator;',
  '  Names: TStringList;',
  'begin',
  '  Calculator := TCalculator.Create(2);',
  '  Names := TStringList.Create;',
  '  try',
  "    Names.Add(Root + 'it''s a total' + #13#10);",
  "    WriteLn(Format('%d', [Add(1, Calculator.Multiply(5, 3))]));  // the sum",
  '    if $FF = 255 then',
  '      WriteLn(Names.Text);',
  '  finally',
  '    Names.Free;',
  '    Calculator.Free;',
  '  end;',
  'end.',
  '',
].join('\n')

describe('delphi lexical highlighting', () => {
  it('lexes a representative sample', () => {
    expectLexes({
      spec,
      source,
      groups: [
        'comment',
        'keyword.directive',
        'string',
        'keyword',
        'type',
        'constant.builtin',
        'function.builtin',
        'function.call',
        'character',
        'number',
        'operator',
      ],
    })
  })

  it('reads a compiler directive as a directive, not as a brace comment', () => {
    expect(textFor({ spec, source, group: 'keyword.directive' })).toEqual(['{$APPTYPE CONSOLE}'])
    expect(textFor({ spec, source, group: 'comment' })).toEqual([
      '{ scaled product }',
      '// the sum',
    ])
  })

  it('reads the parenthesised directive form ahead of its comment twin', () => {
    expect(textFor({ spec, source: '(*$R+*) (* a note *)', group: 'keyword.directive' })).toEqual([
      '(*$R+*)',
    ])
    expect(textFor({ spec, source: '(*$R+*) (* a note *)', group: 'comment' })).toEqual([
      '(* a note *)',
    ])
  })

  it('reads a control character literal whole', () => {
    expect(textFor({ spec, source, group: 'character' })).toEqual(['#13', '#10'])
  })

  it('reads a hex character literal only behind the dollar', () => {
    expect(textFor({ spec, source: 'Ch := #$0D; Tab := #9;', group: 'character' })).toEqual([
      '#$0D',
      '#9',
    ])
  })

  it('reads a doubled quote as part of the string', () => {
    expect(textFor({ spec, source, group: 'string' })).toEqual([
      "'C:\\Temp\\'",
      "'it''s a total'",
      "'%d'",
    ])
  })

  it('closes a string at the quote because a backslash escapes nothing', () => {
    const line = "  Target := Root + 'bin\\';"
    expect(textFor({ spec, source: line, group: 'string' })).toEqual(["'bin\\'"])
    expectPlain({ spec, source: line, text: ';' })
  })

  it('reads a dollar literal as a number', () => {
    expect(textFor({ spec, source, group: 'number' })).toEqual(['2', '1', '5', '3', '$FF', '255'])
  })

  it('reads the assignment as one operator and leaves a declaration colon alone', () => {
    expect(textFor({ spec, source: 'Total := A + B;', group: 'operator' })).toEqual([':=', '+'])
    expectPlain({ spec, source: 'Scale: Integer;', text: ': Integer' })
  })

  it('reads keywords whatever their case', () => {
    expect(textFor({ spec, source: 'IF Ready THEN Halt(1);', group: 'keyword' })).toEqual([
      'IF',
      'THEN',
    ])
    expect(textFor({ spec, source: 'IF Ready THEN Halt(1);', group: 'function.builtin' })).toEqual([
      'Halt',
    ])
  })

  it('reads Result and Self as builtin constants', () => {
    expect(textFor({ spec, source, group: 'constant.builtin' })).toEqual(['Result', 'Result'])
    expect(groupsIn({ spec, source: 'Self.FScale := 0;' })).toContain('constant.builtin')
  })

  it('names a declared type from the word list only', () => {
    const types = textFor({ spec, source, group: 'type' })
    expect([...new Set(types)]).toEqual(['Integer', 'TStringList'])
    expect(types.filter((text) => text === 'TStringList')).toHaveLength(2)
  })

  it('leaves a user type uncoloured rather than typing it by case', () => {
    expectPlain({ spec, source, text: 'TCalculator = class' })
  })

  it('leaves a property name that only reads as a keyword in context alone', () => {
    const line = 'Caption := Edit1.Name + Items[Index] + Report.Message;'
    expectPlain({ spec, source: line, text: 'Name' })
    expectPlain({ spec, source: line, text: 'Index' })
    expectPlain({ spec, source: line, text: 'Message' })
  })

  it('answers to the dpr and objectpascal aliases', () => {
    expect(spec.aliases).toEqual(['dpr', 'objectpascal'])
  })
})
