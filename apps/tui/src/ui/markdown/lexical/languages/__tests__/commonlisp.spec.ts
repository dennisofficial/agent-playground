import { describe, expect, it } from 'bun:test'

import { expectLexes, expectPlain, groupsIn, textFor } from '../../__tests__/harness'
import { commonlisp as spec } from '../commonlisp'

const source = [
  ';;; a small calculator',
  '(in-package :cl-user)',
  '',
  '#| the scale is a special variable',
  '   #| and this comment nests |#',
  '   so the reader keeps going |#',
  '',
  '(defvar *scale* 2 "How much to scale each product.")',
  '',
  '(defun add (a b)',
  '  (+ a b))',
  '',
  '(defclass calculator ()',
  '  ((label :initarg :label :initform "calc" :accessor calculator-label)))',
  '',
  '(defmethod multiply ((c calculator) x &optional (y 1))',
  '  (let* ((product (* x y))',
  '         (scaled (* product *scale*)))',
  '    (return-from multiply scaled)))',
  '',
  '(defun do-report (c)',
  '  (dolist (n (mapcar #\'add (list 1 2) (list 10 20)))',
  '    (format t "~a: ~d~%" (calculator-label c) (multiply c n))))',
  '',
  '(princ (add 2 3))',
  '(princ #\\Newline)',
  '(when (eq t (not nil))',
  '  (do-report (make-instance \'calculator :label "demo")))',
  '',
].join('\n')

describe('common lisp lexical highlighting', () => {
  it('lexes a representative sample', () => {
    expectLexes({
      spec,
      source,
      groups: [
        'comment',
        'string',
        'keyword',
        'function',
        'function.builtin',
        'type',
        'variable',
        'number',
        'constant.builtin',
        'string.special.symbol',
        'character',
      ],
    })
  })

  it('reads a hyphenated or starred symbol as one token', () => {
    expect(
      textFor({ spec, source: '(let* ((x 1)) (return-from multiply x))', group: 'keyword' }),
    ).toEqual(['let*', 'return-from'])
  })

  it('reads a lambda-list marker as a keyword', () => {
    expect(textFor({ spec, source: '(lambda (x &rest more) x)', group: 'keyword' })).toEqual([
      'lambda',
      '&rest',
    ])
  })

  it('names the function each definition form introduces', () => {
    expect(textFor({ spec, source, group: 'function' })).toEqual([
      'add',
      'multiply',
      'do-report',
      "#'add",
    ])
  })

  it('names the class a defclass introduces', () => {
    expect(textFor({ spec, source, group: 'type' })).toEqual(['calculator'])
  })

  it('reads earmuffed globals as variables', () => {
    expect(textFor({ spec, source, group: 'variable' })).toEqual(['*scale*', '*scale*'])
  })

  it('reads a bare star as the multiply function, not a variable', () => {
    expect(textFor({ spec, source: '(* x y)', group: 'function.builtin' })).toEqual(['*'])
  })

  it('nests block comments', () => {
    const nested = '#| outer #| inner |# still outer |#\n(princ 1)'
    expect(textFor({ spec, source: nested, group: 'comment' })).toEqual([
      '#| outer #| inner |# still outer |#',
    ])
  })

  it('reads keyword symbols and sharp-quoted functions', () => {
    expect(textFor({ spec, source: '(list :name #\'add)', group: 'string.special.symbol' })).toEqual(
      [':name'],
    )
    expect(textFor({ spec, source: '(list :name #\'add)', group: 'function' })).toEqual(["#'add"])
  })

  it('reads a character literal whole', () => {
    expect(textFor({ spec, source, group: 'character' })).toEqual(['#\\Newline'])
  })

  it('reads t and nil as builtin constants', () => {
    expect(textFor({ spec, source, group: 'constant.builtin' })).toEqual(['t', 't', 'nil'])
  })

  it('folds case the way the reader does', () => {
    const upper = '(DEFUN ADD (A B) (+ A B))\n(PRINC (ADD 2 3) *STANDARD-OUTPUT*)'
    expect(textFor({ spec, source: upper, group: 'keyword' })).toEqual(['DEFUN'])
    expect(textFor({ spec, source: upper, group: 'function' })).toEqual(['ADD'])
    expect(textFor({ spec, source: upper, group: 'function.builtin' })).toEqual(['+', 'PRINC'])
    expect(textFor({ spec, source: upper, group: 'variable' })).toEqual(['*STANDARD-OUTPUT*'])
  })

  it('reads signed integers, ratios and floats as numbers', () => {
    expect(textFor({ spec, source: '(list -1 1/2 3.5d0 #xFF)', group: 'number' })).toEqual([
      '-1',
      '1/2',
      '3.5d0',
      '#xFF',
    ])
  })

  it('stops a number at the symbol it is part of', () => {
    const incrementers = '(1+ (1- x))'
    expect(textFor({ spec, source: incrementers, group: 'function.builtin' })).toEqual(['1+', '1-'])
    expect(groupsIn({ spec, source: incrementers })).not.toContain('number')
    expectPlain({ spec, source: '(aref 2d-grid 0 0)', text: '2d-grid' })
  })

  it('leaves a symbol that merely begins with a keyword alone', () => {
    expectPlain({ spec, source: '(do-report c)', text: 'do-report' })
    expectPlain({ spec, source, text: 'scaled' })
  })

  it('does not treat a quote as a string opener', () => {
    expect(groupsIn({ spec, source: "(eq 'a 'b)" })).not.toContain('string')
  })

  it('answers to the lisp and elisp aliases too', () => {
    expect(spec.aliases).toEqual(['lisp', 'cl', 'elisp'])
  })
})
