import { describe, expect, it } from 'bun:test'

import { expectLexes, expectPlain, groupsIn, textFor } from '../../__tests__/harness'
import { powershell as spec } from '../powershell'

const source = [
  '<#',
  '    Adds two numbers, then scales a product.',
  '#>',
  '',
  'function Add-Numbers {',
  '    [CmdletBinding()]',
  '    param(',
  '        [Parameter(Mandatory = $true)]',
  '        [int]$Left,',
  '',
  '        [int]$Right',
  '    )',
  '',
  '    return $Left + $Right',
  '}',
  '',
  'class Calculator {',
  '    [int]$Scale = 2',
  '',
  '    [int] Multiply([int]$x, [int]$y) {',
  '        return $x * $y * $this.Scale',
  '    }',
  '}',
  '',
  '$strict = $true',
  '$calc = [Calculator]::new()',
  '$total = Add-Numbers -Left 5 -Right 3',
  '',
  'if ($total -gt 0 -and $null -ne $calc) {',
  '    Write-Output "total is $total"',
  '} else {',
  "    Write-Host 'nothing to add' -ForegroundColor Red",
  '}',
  '',
  '# double every value on the way through',
  '$values = @(1, 2, 3)',
  '$values | ForEach-Object { Write-Output ($_ * $calc.Multiply(2, 1)) }',
  '',
  '$report = @"',
  'total : $total',
  'scaled: $($values.Count)',
  '"@',
  "Set-Content -Path (Join-Path $PSScriptRoot 'totals.txt') -Value $report",
  'Write-Output ${env:USERNAME}',
  '',
].join('\n')

describe('powershell lexical highlighting', () => {
  it('lexes a representative sample', () => {
    expectLexes({
      spec,
      source,
      groups: [
        'comment',
        'string',
        'keyword',
        'type',
        'variable',
        'variable.builtin',
        'constant.builtin',
        'attribute',
        'operator',
        'number',
        'function.call',
        'function.builtin',
      ],
    })
  })

  it('reads the automatic variables as builtins', () => {
    expect(textFor({ spec, source, group: 'variable.builtin' })).toEqual([
      '$this',
      '$_',
      '$PSScriptRoot',
    ])
  })

  it('reads the boolean and null variables as constants, not variables', () => {
    expect(textFor({ spec, source, group: 'constant.builtin' })).toEqual([
      '$true',
      '$true',
      '$null',
    ])
  })

  it('still reads a variable whose name merely starts with a constant as a variable', () => {
    expect(textFor({ spec, source: '$truthy = $True', group: 'variable' })).toEqual(['$truthy'])
    expect(textFor({ spec, source: '$truthy = $True', group: 'constant.builtin' })).toEqual([
      '$True',
    ])
  })

  it('keeps a Verb-Noun cmdlet whole instead of splitting off a switch', () => {
    const call = 'Get-Content -Path $file'
    expect(textFor({ spec, source: call, group: 'function.builtin' })).toEqual(['Get-Content'])
    expect(textFor({ spec, source: call, group: 'attribute' })).toEqual(['-Path'])
    expect(textFor({ spec, source: 'Invoke-Thing $file', group: 'attribute' })).toEqual([])
  })

  it('reads a hyphen comparison as an operator rather than a switch', () => {
    const test = 'if ($left -eq $right -and -not $done) { }'
    expect(textFor({ spec, source: test, group: 'operator' })).toEqual(['-eq', '-and', '-not'])
    expect(textFor({ spec, source: test, group: 'attribute' })).toEqual([])
  })

  it('does not mistake a switch that merely opens with an operator name', () => {
    const call = 'Get-ChildItem -Include *.ps1 -Force -Confirm -InputObject $o -NoNewline'
    expect(textFor({ spec, source: call, group: 'operator' })).toEqual(['*'])
    expect(textFor({ spec, source: call, group: 'attribute' })).toEqual([
      '-Include',
      '-Force',
      '-Confirm',
      '-InputObject',
      '-NoNewline',
    ])
  })

  it('reads a bracketed cast as a type without claiming an index', () => {
    expect(textFor({ spec, source: '[int]$n = $values[0]', group: 'type' })).toEqual(['[int]'])
  })

  it('reads a declaration attribute as an attribute, not a call', () => {
    expect(textFor({ spec, source, group: 'attribute' })).toEqual([
      '[CmdletBinding',
      '[Parameter',
      '-Left',
      '-Right',
      '-ForegroundColor',
      '-Path',
      '-Value',
    ])
    expect(textFor({ spec, source, group: 'function.call' })).toEqual([
      'Multiply',
      'new',
      'Multiply',
    ])
  })

  it('holds a here-string together in both quoting forms', () => {
    const double = '$a = @"\nline $x\n"@\n$b = 1'
    expect(textFor({ spec, source: double, group: 'string' })).toEqual(['@"\nline $x\n"@'])
    const single = "$a = @'\nline $x\n'@\n$b = 1"
    expect(textFor({ spec, source: single, group: 'string' })).toEqual(["@'\nline $x\n'@"])
    expect(textFor({ spec, source: double, group: 'number' })).toEqual(['1'])
  })

  it('reads a scoped variable as one token, braced or bare', () => {
    expect(textFor({ spec, source: '$env:ATLAS_HOME = $home', group: 'variable' })).toEqual([
      '$env:ATLAS_HOME',
    ])
    expect(textFor({ spec, source: '${env:Program Files} = 1', group: 'variable' })).toEqual([
      '${env:Program Files}',
    ])
  })

  it('folds keywords to the case the script was written in', () => {
    expect(groupsIn({ spec, source: 'Foreach ($n In 1..3) { Return $n }' })).toContain('keyword')
    expect(textFor({ spec, source: 'IF ($x -EQ 1) { WRITE-OUTPUT $x }', group: 'keyword' })).toEqual(
      ['IF'],
    )
    expect(
      textFor({ spec, source: 'IF ($x -EQ 1) { WRITE-OUTPUT $x }', group: 'function.builtin' }),
    ).toEqual(['WRITE-OUTPUT'])
  })

  it('reads a block comment before treating the hash as a line comment', () => {
    expect(textFor({ spec, source: '<# note #>\n$x = 1', group: 'comment' })).toEqual(['<# note #>'])
  })

  it('honours the backtick as the double-quoted escape', () => {
    expect(textFor({ spec, source: '$s = "a`"b" + 1', group: 'string' })).toEqual(['"a`"b"'])
  })

  it('leaves an attribute argument name alone', () => {
    expectPlain({ spec, source, text: 'Mandatory' })
  })

  it('leaves a bare argument word alone', () => {
    expectPlain({ spec, source, text: 'Red' })
  })

  it('answers to the ps1, pwsh and posh aliases', () => {
    expect(spec.aliases).toEqual(['ps1', 'pwsh', 'posh'])
  })
})
