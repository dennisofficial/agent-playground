import { describe, expect, it } from 'bun:test'

import { expectLexes, expectPlain, groupsIn, textFor } from '../../__tests__/harness'
import { vbnet as spec } from '../vbnet'

const source = [
  "' A tiny calculator, the classic way.",
  'Imports System',
  'Imports System.Collections.Generic',
  '',
  'Namespace Demo',
  '',
  '    Public Class Calculator',
  '',
  '        Private ReadOnly _scale As Integer',
  '        Private Const Mask As Integer = &HFF',
  '        Private Const Verbose As Boolean = True',
  '',
  '        Public Sub New(ByVal scale As Integer)',
  '            Me._scale = scale',
  '        End Sub',
  '',
  '        <Obsolete(), NonSerialized()>',
  '        Public Function Multiply(ByVal x As Integer, ByVal y As Integer) As Integer',
  '            If x = 0 OrElse y = 0 Then',
  '                Return 0',
  '            End If',
  '            Return (x * y * _scale) And Mask',
  '        End Function',
  '',
  '    End Class',
  '',
  '    Module Program',
  '',
  '        Public Function Add(ByVal x As Integer, ByVal y As Integer) As Integer',
  '            Return x + y',
  '        End Function',
  '',
  '        Sub Main()',
  '            Dim calc As New Calculator(2)',
  '            Dim history As New List(Of Integer)()',
  '            Dim remainder As Integer = 10 Mod 3',
  '            Dim label As String = "total = ""scaled"""',
  '            REM the legacy comment form still works',
  '            If calc IsNot Nothing Then',
  '                history.Add(Add(5, 3))',
  '                history.Add(calc.Multiply(5, remainder))',
  '            End If',
  '            For Each item As Integer In history',
  '#If DEBUG Then',
  '                Console.WriteLine(label & item)',
  '#End If',
  '            Next',
  '        End Sub',
  '',
  '    End Module',
  '',
  'End Namespace',
  '',
].join('\n')

describe('vbnet lexical highlighting', () => {
  it('lexes a representative sample', () => {
    expectLexes({
      spec,
      source,
      groups: [
        'comment',
        'string',
        'keyword',
        'keyword.directive',
        'type',
        'attribute',
        'number',
        'operator',
        'function.call',
        'constant.builtin',
      ],
    })
  })

  it('reads a single quote and a REM as the two comment forms', () => {
    expect(textFor({ spec, source, group: 'comment' })).toEqual([
      "' A tiny calculator, the classic way.",
      'REM the legacy comment form still works',
    ])
  })

  it('reads a doubled quote as one string rather than two', () => {
    expect(textFor({ spec, source, group: 'string' })).toEqual(['"total = ""scaled"""'])
  })

  it('never reads a single-quoted run as a string', () => {
    expect(groupsIn({ spec, source: "Dim s = 'not a string'" })).not.toContain('string')
  })

  it('reads an attribute list whole, parenthesised arguments included', () => {
    expect(textFor({ spec, source, group: 'attribute' })).toEqual(['<Obsolete(), NonSerialized()>'])
    expect(
      textFor({
        spec,
        source: '<DefaultValue(GetType(Integer), 0)> Public Property Size As Integer',
        group: 'attribute',
      }),
    ).toEqual(['<DefaultValue(GetType(Integer), 0)>'])
  })

  it('reads an ampersand-H run as one hex literal', () => {
    expect(textFor({ spec, source, group: 'number' })).toContain('&HFF')
    const hex = 'Dim mask As Integer = &HFF'
    expect(textFor({ spec, source: hex, group: 'number' })).toEqual(['&HFF'])
    expect(textFor({ spec, source: hex, group: 'operator' })).toEqual(['='])
    expect(textFor({ spec, source: 'Dim m = &O17 Or &B1010', group: 'number' })).toEqual([
      '&O17',
      '&B1010',
    ])
  })

  it('reads a conditional-compilation directive as a directive', () => {
    expect(textFor({ spec, source, group: 'keyword.directive' })).toEqual(['#If', '#End'])
    expect(textFor({ spec, source: '#Region "helpers"', group: 'keyword.directive' })).toEqual([
      '#Region',
    ])
  })

  it('reads the built-in literals as constants', () => {
    expect(textFor({ spec, source, group: 'constant.builtin' })).toEqual([
      'True',
      'Me',
      'Nothing',
    ])
  })

  it('folds keywords and types to any casing', () => {
    const lower = 'dim total as integer = nothing'
    expect(textFor({ spec, source: lower, group: 'keyword' })).toEqual(['dim', 'as'])
    expect(textFor({ spec, source: lower, group: 'type' })).toEqual(['integer'])
    expect(textFor({ spec, source: lower, group: 'constant.builtin' })).toEqual(['nothing'])
    expect(textFor({ spec, source: 'rem lowercase too', group: 'comment' })).toEqual([
      'rem lowercase too',
    ])
  })

  it('leaves a REM-prefixed word alone', () => {
    expectPlain({ spec, source, text: 'remainder' })
    expect(
      textFor({ spec, source: 'RemoveHandler Timer.Tick, AddressOf OnTick', group: 'keyword' }),
    ).toEqual(['RemoveHandler', 'AddressOf'])
  })

  it('leaves a concatenated identifier out of the hex literal', () => {
    expect(groupsIn({ spec, source: 'Dim greeting = prefix &Hello' })).not.toContain('number')
  })

  it('does not read a less-than comparison as an attribute', () => {
    expect(groupsIn({ spec, source: 'If count < limit Then' })).not.toContain('attribute')
    expect(groupsIn({ spec, source: 'If a < b AndAlso c > d Then' })).not.toContain('attribute')
  })

  it('answers to the vb aliases too', () => {
    expect(spec.aliases).toEqual(['vb', 'vb.net', 'visualbasic'])
  })
})
