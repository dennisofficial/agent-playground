import { describe, expect, it } from 'bun:test'

import { expectLexes, expectPlain, groupsIn, textFor } from '../../__tests__/harness'
import { tcl as spec } from '../tcl'

const source = [
  '#!/usr/bin/env tclsh',
  '# a calculator in tcl',
  'package require Tcl 8.6',
  '',
  'proc add {a b} {',
  '    return [expr {$a + $b}]',
  '}',
  '',
  'namespace eval Calculator {',
  '    variable scale 2',
  '',
  '    proc multiply {x y} {',
  '        variable scale',
  '        if {![string is integer -strict $x]} {',
  '            error "multiply: $x is not an integer"',
  '        }',
  '        # fold the module scale in',
  '        return [expr {$x * $y * ${scale}}]',
  '    }',
  '}',
  '',
  'array set counts {add 0 multiply 0}',
  'incr counts(add)',
  '',
  'set total [add 5 3]',
  'set label item#42',
  'set infoText "ready"',
  'set banner "tcl calculator',
  'ready to add and multiply"',
  '',
  'puts stdout "total = $total"',
  'puts $::tcl_version',
  'puts [Calculator::multiply 5 3]',
  '',
  'foreach n [list 1 2 3] {',
  '    incr total $n',
  '}',
  '',
].join('\n')

describe('tcl lexical highlighting', () => {
  it('lexes a representative sample', () => {
    expectLexes({
      spec,
      source,
      groups: [
        'comment',
        'string',
        'keyword',
        'variable',
        'function.builtin',
        'constant.builtin',
        'number',
        'operator',
      ],
    })
  })

  it('reads every dollar substitution form as a variable', () => {
    expect(textFor({ spec, source, group: 'variable' })).toEqual([
      '$a',
      '$b',
      '$x',
      '$x',
      '$y',
      '${scale}',
      '$::tcl_version',
      '$n',
    ])
  })

  it('reads a hash as a comment only where a command may start', () => {
    expect(textFor({ spec, source, group: 'comment' })).toEqual([
      '#!/usr/bin/env tclsh',
      '# a calculator in tcl',
      '# fold the module scale in',
    ])
  })

  it('leaves a mid-line hash inside a bare word alone', () => {
    expect(textFor({ spec, source: 'set label item#42', group: 'comment' })).toEqual([])
    expect(groupsIn({ spec, source: 'set label item#42' })).toEqual(new Set(['keyword', 'number']))
  })

  it('reads ensemble commands as builtins', () => {
    expect(textFor({ spec, source, group: 'function.builtin' })).toEqual([
      'string',
      'array',
      'puts',
      'puts',
      'puts',
      'list',
    ])
  })

  it('reads a channel name as a builtin constant', () => {
    expect(textFor({ spec, source, group: 'constant.builtin' })).toEqual(['stdout'])
  })

  it('swallows a substitution inside a quoted word', () => {
    expect(textFor({ spec, source, group: 'string' })).toEqual([
      '"multiply: $x is not an integer"',
      '"ready"',
      '"tcl calculator\nready to add and multiply"',
      '"total = $total"',
    ])
  })

  it('carries a quoted word across a newline, as tcl does', () => {
    expect(textFor({ spec, source: 'set a "one\ntwo"\nputs $a', group: 'string' })).toEqual([
      '"one\ntwo"',
    ])
  })

  it('does not read a keyword prefix as a keyword', () => {
    expectPlain({ spec, source, text: 'infoText' })
  })

  it('leaves an array element name alone rather than calling it a function', () => {
    expectPlain({ spec, source, text: 'counts(add)' })
    expect(groupsIn({ spec, source: 'set env(HOME) "home"' })).toEqual(
      new Set(['keyword', 'string']),
    )
  })

  it('answers to the tk alias too', () => {
    expect(spec.aliases).toContain('tk')
  })
})
