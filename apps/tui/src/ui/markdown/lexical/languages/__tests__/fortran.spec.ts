import { describe, expect, it } from 'bun:test'

import { expectLexes, expectPlain, groupsIn, textFor } from '../../__tests__/harness'
import { fortran as spec } from '../fortran'

const source = [
  '! a calculator',
  'module calculator_mod',
  '   implicit none',
  '   private',
  '',
  '   integer, parameter :: dp = kind(1.0d0)',
  '',
  '   type, public :: Calculator',
  '      real(dp) :: scale = 1.0_dp',
  '   contains',
  '      procedure :: multiply',
  '   end type Calculator',
  '',
  '   public :: add, dp',
  '',
  'contains',
  '',
  '   pure function add(a, b) result(total)',
  '      integer, intent(in) :: a, b',
  '      integer :: total',
  '',
  '      total = a + b',
  '   end function add',
  '',
  '   function multiply(self, x, y) result(scaled)',
  '      class(Calculator), intent(in) :: self',
  '      real(dp), intent(in) :: x, y',
  '      real(dp) :: scaled',
  '',
  '      scaled = x * y * self%scale',
  '   end function multiply',
  '',
  'end module calculator_mod',
  '',
  'program main',
  '   use calculator_mod, only: Calculator, add, dp',
  '   implicit none',
  '',
  '   type(Calculator) :: calc',
  '   logical :: ok',
  '',
  '   calc%scale = 2.0_dp',
  '   ok = .true.',
  '',
  '   if (ok .and. add(2, 3) == 5) then',
  '      print \'(a, f8.3)\', "scaled = ", calc%multiply(5.0_dp, 3.0_dp)',
  '   else',
  "      write (*, *) 'mismatch'",
  '      error stop 1',
  '   end if',
  'end program main',
  '',
].join('\n')

const fixedForm = [
  'C     LEGACY FIXED SOURCE FORM',
  '*     STILL A COMMENT',
  '      PROGRAM OLD',
  '      WRITE (*, *) 2 + 3',
  '      END',
  '',
].join('\n')

describe('fortran lexical highlighting', () => {
  it('lexes a representative sample', () => {
    expectLexes({
      spec,
      source,
      groups: [
        'comment',
        'string',
        'keyword',
        'type',
        'punctuation',
        'variable.member',
        'function.call',
        'function.builtin',
        'number',
        'constant.builtin',
        'operator',
      ],
    })
  })

  it('reads the dotted logical literal as a builtin constant', () => {
    expect(textFor({ spec, source, group: 'constant.builtin' })).toEqual(['.true.'])
  })

  it('reads a dotted logical operator as an operator', () => {
    expect(textFor({ spec, source: 'ok = a .AND. .not. b', group: 'operator' })).toEqual([
      '=',
      '.AND.',
      '.not.',
    ])
  })

  it('reads a component reference as a member', () => {
    expect(textFor({ spec, source, group: 'variable.member' })).toEqual([
      '%scale',
      '%scale',
      '%multiply',
    ])
  })

  it('reads the declaration separator as punctuation', () => {
    expect(textFor({ spec, source: 'integer :: n', group: 'punctuation' })).toEqual(['::'])
  })

  it('reads intrinsic types apart from keywords', () => {
    expect(textFor({ spec, source: 'double precision :: total', group: 'type' })).toEqual([
      'double',
      'precision',
    ])
  })

  it('reads kind-suffixed and double-exponent literals whole', () => {
    expect(textFor({ spec, source, group: 'number' })).toEqual([
      '1.0d0',
      '1.0_dp',
      '2.0_dp',
      '2',
      '3',
      '5',
      '5.0_dp',
      '3.0_dp',
      '1',
    ])
  })

  it('reads a doubled quote as part of the string', () => {
    expect(textFor({ spec, source: "msg = 'it''s fine'", group: 'string' })).toEqual([
      "'it''s fine'",
    ])
  })

  it('does not treat a backslash as an escape', () => {
    expect(textFor({ spec, source: "path = 'C:\\temp\\' // name", group: 'string' })).toEqual([
      "'C:\\temp\\'",
    ])
  })

  it('keeps a dotted operator that follows a bare integer', () => {
    expect(textFor({ spec, source: 'if (100.lt.n) stop', group: 'operator' })).toEqual(['.lt.'])
    expect(textFor({ spec, source: 'if (100.lt.n) stop', group: 'number' })).toEqual(['100'])
  })

  it('still reads a trailing-point real literal', () => {
    expect(textFor({ spec, source: 'x = 1./3.', group: 'number' })).toEqual(['1.', '3.'])
  })

  it('folds uppercase keywords', () => {
    expect(textFor({ spec, source: fixedForm, group: 'keyword' })).toEqual([
      'PROGRAM',
      'WRITE',
      'END',
    ])
  })

  it('reads a column-one letter or star as a fixed-form comment', () => {
    expect(textFor({ spec, source: fixedForm, group: 'comment' })).toEqual([
      'C     LEGACY FIXED SOURCE FORM',
      '*     STILL A COMMENT',
    ])
  })

  it('leaves a column-one identifier alone in free source form', () => {
    expect(groupsIn({ spec, source: 'Cost = 12\n' })).toEqual(new Set(['operator', 'number']))
    expectPlain({ spec, source: 'Cost = 12\n', text: 'Cost' })
  })

  it('leaves a column-one assignment to c alone', () => {
    expect(groupsIn({ spec, source: 'c = a + b\n' })).toEqual(new Set(['operator']))
    expectPlain({ spec, source: 'c = a + b\n', text: 'c' })
  })

  it('leaves a column-one c that indexes, selects or labels alone', () => {
    for (const line of ['c(i) = a(i) + b(i)\n', 'c%field = 1\n', 'c: do i = 1, 10\n']) {
      expect(textFor({ spec, source: line, group: 'comment' })).toEqual([])
    }
  })

  it('leaves a column-one contains statement alone', () => {
    expect(textFor({ spec, source: 'contains\n', group: 'keyword' })).toEqual(['contains'])
    expect(textFor({ spec, source: 'CALL solve(n)\n', group: 'keyword' })).toEqual(['CALL'])
  })

  it('never matches a keyword inside a longer name', () => {
    expectPlain({ spec, source, text: 'calculator_mod' })
  })

  it('answers to the f90 alias too', () => {
    expect(spec.aliases).toContain('f90')
  })
})
