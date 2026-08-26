import { describe, expect, it } from 'bun:test'

import { expectLexes, expectPlain, textFor } from '../../__tests__/harness'
import { ada as spec } from '../ada'

const source = [
  '--  A tiny calculator held in a nested package.',
  'with Ada.Text_IO;         use Ada.Text_IO;',
  'with Ada.Integer_Text_IO;',
  '',
  'procedure Main is',
  '',
  '   Verbose : constant Boolean   := True;',
  '   Grade   : constant Character := \'A\';',
  '   Mask    : constant Integer   := 16#FF#;',
  '   Lowest  : constant Integer   := Integer\'Base\'First;',
  '',
  '   subtype Small is Integer range 0 .. 100;',
  '',
  '   package Calculator is',
  '      function Add (Left, Right : Integer) return Integer;',
  '      function Multiply (Left, Right : Integer) return Integer;',
  '   end Calculator;',
  '',
  '   package body Calculator is',
  '',
  '      Scale : constant Small := 2;',
  '',
  '      function Add (Left, Right : Integer) return Integer is',
  '      begin',
  '         return Left + Right;',
  '      end Add;',
  '',
  '      function Multiply (Left, Right : Integer) return Integer is',
  '         Total : Integer := 0;',
  '      begin',
  '         for Count in 1 .. Right loop',
  '            Total := Total + Left;',
  '         end loop;',
  '         return Total * Scale;',
  '      end Multiply;',
  '',
  '   end Calculator;',
  '',
  'begin',
  '   Put_Line ("sum ="     & Integer\'Image (Calculator.Add (2, 3)));',
  '   Put_Line ("product =" & Integer\'Image (Calculator.Multiply (5, 3)));',
  '   Put_Line ("floor ="   & Integer\'Image (Lowest));',
  '   Ada.Integer_Text_IO.Put (Calculator.Add (2, 3));',
  '   New_Line;',
  '',
  '   Put_Line ("she said ""done"" and left");',
  '',
  '   case Grade is',
  '      when \'A\'    => Put_Line ("top of the class");',
  '      when others => null;',
  '   end case;',
  '',
  '   if Verbose and then Mask /= 0 then',
  '      raise Program_Error with "arithmetic is broken";',
  '   end if;',
  'end Main;',
  '',
].join('\n')

describe('ada lexical highlighting', () => {
  it('lexes a representative sample', () => {
    expectLexes({
      spec,
      source,
      groups: [
        'comment',
        'string',
        'keyword',
        'type',
        'attribute',
        'character',
        'number',
        'constant.builtin',
        'function.call',
        'operator',
      ],
    })
  })

  it('reads an attribute tick as an attribute, not a character literal', () => {
    expect(textFor({ spec, source, group: 'attribute' })).toEqual([
      "'Base",
      "'First",
      "'Image",
      "'Image",
      "'Image",
    ])
  })

  it('keeps an attribute call from swallowing the rest of its line', () => {
    const line = '   Put_Line ("sum =" & Integer\'Image (Add (2, 3)));'
    expect(textFor({ spec, source: line, group: 'string' })).toEqual(['"sum ="'])
    expect(textFor({ spec, source: line, group: 'attribute' })).toEqual(["'Image"])
    expect(textFor({ spec, source: line, group: 'function.call' })).toEqual(['Put_Line', 'Add'])
  })

  it('reads a character literal as a character', () => {
    expect(textFor({ spec, source, group: 'character' })).toEqual(["'A'", "'A'"])
  })

  it('reads the tick character literal without help from the attribute rule', () => {
    expect(textFor({ spec, source: "Tick : constant Character := ''';", group: 'character' })).toEqual([
      "'''",
    ])
  })

  it('closes a string on the doubled quote form', () => {
    expect(textFor({ spec, source, group: 'string' })).toEqual([
      '"sum ="',
      '"product ="',
      '"floor ="',
      '"she said ""done"" and left"',
      '"top of the class"',
      '"arithmetic is broken"',
    ])
  })

  it('reads a based literal as one number', () => {
    expect(textFor({ spec, source, group: 'number' })).toEqual([
      '16#FF#',
      '0',
      '100',
      '2',
      '0',
      '1',
      '2',
      '3',
      '5',
      '3',
      '2',
      '3',
      '0',
    ])
  })

  it('folds keyword case so an uppercase spelling still lexes', () => {
    const line = 'PROCEDURE Main IS BEGIN NULL; END Main;'
    expect(textFor({ spec, source: line, group: 'keyword' })).toEqual([
      'PROCEDURE',
      'IS',
      'BEGIN',
      'END',
    ])
    expect(textFor({ spec, source: line, group: 'constant.builtin' })).toEqual(['NULL'])
    expectPlain({ spec, source: line, text: 'Main' })
  })

  it('keeps a chained attribute whole', () => {
    const line = "   Item := Shape'Class'Input (Stream);"
    expect(textFor({ spec, source: line, group: 'attribute' })).toEqual(["'Class", "'Input"])
    expectPlain({ spec, source: line, text: 'Stream' })
  })

  it('reads the boolean literals as builtin constants', () => {
    expect(textFor({ spec, source, group: 'constant.builtin' })).toEqual(['True', 'null'])
  })

  it('leaves a type name embedded in a longer identifier alone', () => {
    expectPlain({ spec, source, text: 'Integer_Text_IO' })
  })

  it('leaves an ordinary local alone', () => {
    expectPlain({ spec, source, text: 'Grade   :' })
  })

  it('leaves an uppercase-initial name that is not a keyword uncoloured', () => {
    expectPlain({ spec, source, text: 'Program_Error' })
  })

  it('answers to the adb and ads aliases too', () => {
    expect(spec.aliases).toEqual(['adb', 'ads'])
  })
})
