import { describe, expect, it } from 'bun:test'

import { expectLexes, expectPlain, textFor } from '../../__tests__/harness'
import { autohotkey as spec } from '../autohotkey'

const source = [
  '; a calculator',
  '#SingleInstance Force',
  '',
  'add(x, y) {',
  '    return x + y',
  '}',
  '',
  'class Calculator {',
  '    verbose := false',
  '',
  '    __New(scale) {',
  '        this.scale := scale',
  '    }',
  '',
  '    multiply(x, y) {',
  '        total := 0',
  '        Loop, %y%',
  '            total += x  ; accumulate',
  '        return total * this.scale',
  '    }',
  '}',
  '',
  '^!c::',
  '    calc := new Calculator(3)',
  '    total := calc.multiply(add(2, 3), 4)',
  '    caption := "he said ""hi"""',
  '    MsgBox, %caption% %total%',
  'return',
  '',
  'Numpad0 & Numpad1::',
  '    Send, {Enter}',
  'return',
  '',
  '::calc::calculator',
  '',
].join('\n')

describe('autohotkey lexical highlighting', () => {
  it('lexes a representative sample', () => {
    expectLexes({
      spec,
      source,
      groups: [
        'comment',
        'keyword.directive',
        'label',
        'string',
        'keyword',
        'variable',
        'variable.builtin',
        'constant.builtin',
        'function.call',
        'function.builtin',
        'number',
        'operator',
      ],
    })
  })

  it('reads a hotkey, a combined hotkey and a hotstring as labels', () => {
    expect(textFor({ spec, source, group: 'label' })).toEqual([
      '^!c::',
      'Numpad0 & Numpad1::',
      '::calc::',
    ])
  })

  it('reads a symbol key behind a modifier run as a hotkey', () => {
    expect(textFor({ spec, source: '^!,::Run("notepad")', group: 'label' })).toEqual(['^!,::'])
  })

  it('reads percent-delimited substitution as a variable', () => {
    expect(textFor({ spec, source, group: 'variable' })).toEqual(['%y%', '%caption%', '%total%'])
  })

  it('closes a string on a doubled quote rather than a backslash', () => {
    expect(textFor({ spec, source, group: 'string' })).toEqual(['"he said ""hi"""'])
  })

  it('carries a backtick-escaped quote through a string', () => {
    const escaped = 'MsgBox("say `"hi`" now")'
    expect(textFor({ spec, source: escaped, group: 'string' })).toEqual(['"say `"hi`" now"'])
  })

  it('reads a v2 single-quoted string, doubling included', () => {
    expect(textFor({ spec, source: "MsgBox('hi ''there''')", group: 'string' })).toEqual([
      "'hi ''there'''",
    ])
  })

  it('leaves a lone apostrophe in legacy command text uncoloured', () => {
    const legacy = "MsgBox, It's fine"
    expect(textFor({ spec, source: legacy, group: 'string' })).toEqual([])
    expectPlain({ spec, source: legacy, text: "It's fine" })
  })

  it('reads a directive at the head of a line', () => {
    expect(textFor({ spec, source, group: 'keyword.directive' })).toEqual(['#SingleInstance'])
  })

  it('reads a semicolon comment both at the head of a line and after code', () => {
    expect(textFor({ spec, source, group: 'comment' })).toEqual(['; a calculator', '; accumulate'])
  })

  it('prefers a comment over a hotkey on a semicolon at the head of a line', () => {
    const commented = ';:: not a hotkey'
    expect(textFor({ spec, source: commented, group: 'comment' })).toEqual([commented])
    expect(textFor({ spec, source: commented, group: 'label' })).toEqual([])
  })

  it('reads built-in commands and built-in variables', () => {
    expect(textFor({ spec, source, group: 'function.builtin' })).toEqual(['MsgBox', 'Send'])
    expect(textFor({ spec, source, group: 'variable.builtin' })).toEqual(['this', 'this'])
  })

  it('folds keyword case the way the language does', () => {
    expect(textFor({ spec, source: 'RETURN A_Index', group: 'keyword' })).toEqual(['RETURN'])
    expect(textFor({ spec, source: 'RETURN A_Index', group: 'variable.builtin' })).toEqual([
      'A_Index',
    ])
  })

  it('reads a word operator as a keyword rather than a call', () => {
    expect(textFor({ spec, source: 'if not (a and b)', group: 'keyword' })).toEqual([
      'if',
      'not',
      'and',
    ])
    expect(textFor({ spec, source: 'if not (a and b)', group: 'function.call' })).toEqual([])
  })

  it('does not mistake an assignment at the head of a line for a hotkey', () => {
    expectPlain({ spec, source, text: 'calc :=' })
  })

  it('does not read a built-in name inside a longer command', () => {
    expectPlain({ spec, source: 'WinWaitClose, ahk_class Notepad', text: 'WinWaitClose' })
  })

  it('answers to the ahk alias too', () => {
    expect(spec.aliases).toContain('ahk')
  })
})
