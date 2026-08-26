import { describe, expect, it } from 'bun:test'

import { expectLexes, expectPlain, groupsIn, textFor } from '../../__tests__/harness'
import { racket as spec } from '../racket'

const source = [
  '#lang racket/base',
  '',
  ';; a small calculator',
  '(require racket/contract)',
  '(provide (contract-out [add (-> number? number? number?)]))',
  '',
  '(define (add x y)',
  '  (+ x y))',
  '',
  '(struct calculator (scale) #:transparent)',
  '',
  '(define (calculator-multiply calc x y)',
  '  (let* ([scale (calculator-scale calc)]',
  '         [product (* x y scale)])',
  '    (cond',
  '      [(zero? product) 0]',
  '      [else product])))',
  '',
  '#| a nested',
  '   #| block |# comment',
  '|#',
  '',
  '#;(displayln "unused")',
  '',
  '(define half 1/2)',
  '(define scales #(1 2 4))',
  '(define double (λ (n) (* 2 n)))',
  "(define table (hash 'add add 'multiply calculator-multiply))",
  '',
  '(when (and #t (not #f))',
  '  (for/list ([i (in-range 3)])',
  '    (displayln (format "~a" i))))',
  '',
  '(display #\\newline)',
  '(displayln (string-append "product: " (number->string (calculator-multiply (calculator half) 5 3))))',
  '',
].join('\n')

describe('racket lexical highlighting', () => {
  it('lexes a representative sample', () => {
    expectLexes({
      spec,
      source,
      groups: [
        'comment',
        'string',
        'keyword',
        'keyword.directive',
        'constant.builtin',
        'function.builtin',
        'number',
        'attribute',
        'character',
        'punctuation',
        'string.special.symbol',
      ],
    })
  })

  it('reads the #lang line as a directive', () => {
    expect(textFor({ spec, source, group: 'keyword.directive' })).toEqual(['#lang racket/base'])
  })

  it('reads a #lang form mid-expression as ordinary text', () => {
    expectPlain({ spec, source: '(list x #lang y)', text: '#lang' })
  })

  it('keeps a hyphenated symbol whole', () => {
    expectPlain({ spec, source: '(cons or-else and-then)', text: 'or-else' })
    expectPlain({ spec, source: '(cons or-else and-then)', text: 'and-then' })
  })

  it('reads a punctuated keyword whole', () => {
    const keywords = textFor({ spec, source, group: 'keyword' })
    expect(keywords).toContain('let*')
    expect(keywords).toContain('for/list')
    expect(keywords).toContain('λ')
    expect(textFor({ spec, source: '(set! total 1)', group: 'keyword' })).toEqual(['set!'])
  })

  it('leaves a lambda glyph inside a longer name alone', () => {
    expectPlain({ spec, source: '(define λ-ish 1)', text: 'λ-ish' })
  })

  it('nests a block comment', () => {
    expect(textFor({ spec, source: '#| a #| b |# c |# (add 1 2)', group: 'comment' })).toEqual([
      '#| a #| b |# c |#',
    ])
  })

  it('reads a datum comment through the end of the line', () => {
    expect(textFor({ spec, source, group: 'comment' })).toContain('#;(displayln "unused")')
  })

  it('reads booleans as builtin constants', () => {
    expect(textFor({ spec, source, group: 'constant.builtin' })).toEqual(['#t', '#f'])
    expect(textFor({ spec, source: '(and #true #false)', group: 'constant.builtin' })).toEqual([
      '#true',
      '#false',
    ])
  })

  it('reads a keyword argument as an attribute', () => {
    expect(textFor({ spec, source, group: 'attribute' })).toEqual(['#:transparent'])
  })

  it('reads a character literal', () => {
    expect(textFor({ spec, source, group: 'character' })).toEqual(['#\\newline'])
    expect(textFor({ spec, source: '(display #\\")', group: 'character' })).toEqual(['#\\"'])
  })

  it('reads a quoted symbol', () => {
    expect(textFor({ spec, source, group: 'string.special.symbol' })).toEqual([
      "'add",
      "'multiply",
    ])
  })

  it('reads a rational as one number', () => {
    expect(textFor({ spec, source, group: 'number' })).toContain('1/2')
  })

  it('reads a negative literal as one number', () => {
    expect(textFor({ spec, source: '(define delta -1.5)', group: 'number' })).toEqual(['-1.5'])
    expect(textFor({ spec, source: '(vector-set! v 0 -3)', group: 'number' })).toEqual(['0', '-3'])
    expect(textFor({ spec, source: '(define big +inf.0)', group: 'number' })).toEqual(['+inf.0'])
  })

  it('leaves subtraction and the arrow contract uncoloured', () => {
    expectPlain({ spec, source: '(- 5 3)', text: '-' })
    expectPlain({ spec, source: '(-> number? void?)', text: '->' })
  })

  it('reads a radix literal as one number', () => {
    expect(textFor({ spec, source: '(bitwise-and mask #x1f)', group: 'number' })).toEqual(['#x1f'])
    expect(textFor({ spec, source: '(define bits #b1010)', group: 'number' })).toEqual(['#b1010'])
  })

  it('reads a reader prefix as punctuation rather than a procedure', () => {
    const literal = '(define h #hash((a . 1)))'
    expect(textFor({ spec, source: literal, group: 'punctuation' })).toEqual(['#hash'])
    expect(textFor({ spec, source: literal, group: 'function.builtin' })).toEqual([])
    expect(textFor({ spec, source, group: 'punctuation' })).toEqual(['#'])
  })

  it('leaves an arithmetic procedure uncoloured', () => {
    expect(groupsIn({ spec, source: '(* x y)' }).size).toBe(0)
  })

  it('answers to the rkt alias too', () => {
    expect(spec.aliases).toContain('rkt')
  })
})
