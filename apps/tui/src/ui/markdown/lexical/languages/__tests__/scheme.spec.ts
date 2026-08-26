import { describe, expect, it } from 'bun:test'

import { expectLexes, expectPlain, groupsIn, textFor } from '../../__tests__/harness'
import { scheme as spec } from '../scheme'

const source = [
  ';; a calculator',
  '(import (scheme base)',
  '        (scheme write))',
  '',
  '(define (add a b)',
  '  (+ a b))',
  '',
  '(define-record-type <calculator>',
  '  (make-calculator scale)',
  '  calculator?',
  '  (scale calculator-scale set-calculator-scale!))',
  '',
  '(define (calculator-multiply calc x y)',
  '  (let* ((scale (calculator-scale calc))',
  '         (product (* x y)))',
  '    (if (= scale 0)',
  '        (error "scale must not be zero" scale)',
  '        (* product scale))))',
  '',
  '(define-syntax swap!',
  '  (syntax-rules ()',
  '    ((_ a b)',
  '     (let ((tmp a))',
  '       (set! a b)',
  '       (set! b tmp)))))',
  '',
  "(define primes '(2 3 5 7))",
  '(define letters (list #\\a #\\b #\\c #\\space))',
  '',
  '#| the entry point,',
  '   #| nested |# and all |#',
  '(define (main)',
  '  (let ((calc (make-calculator 2)))',
  '    (display (add 1 2))',
  '    (newline)',
  '    (display (calculator-multiply calc 5 -3))',
  '    (newline)',
  '    (display (if (null? letters) #f #true))',
  '    (newline)',
  '    #;(display (add 1 2))',
  '    (display (length primes))',
  '    (newline)',
  '    (display 1/2)',
  '    (newline)))',
  '',
  '(main)',
  '',
].join('\n')

describe('scheme lexical highlighting', () => {
  it('lexes a representative sample', () => {
    expectLexes({
      spec,
      source,
      groups: [
        'comment',
        'string',
        'keyword',
        'function.builtin',
        'number',
        'character',
        'constant.builtin',
      ],
    })
  })

  it('reads a punctuated keyword as a single token', () => {
    expect(
      textFor({ spec, source: '(define-syntax swap! (syntax-rules ()))', group: 'keyword' }),
    ).toEqual(['define-syntax', 'syntax-rules'])
  })

  it('reads a bang-terminated keyword as a single token', () => {
    expect(textFor({ spec, source: '(set! total 1)', group: 'keyword' })).toEqual(['set!'])
  })

  it('keeps hyphens and stars inside the keywords of the sample', () => {
    const keywords = textFor({ spec, source, group: 'keyword' })
    expect(keywords).toContain('define-record-type')
    expect(keywords).toContain('define-syntax')
    expect(keywords).toContain('let*')
    expect(keywords).toContain('set!')
  })

  it('reads nesting block comments, the line comment and the datum comment', () => {
    expect(textFor({ spec, source, group: 'comment' })).toEqual([
      ';; a calculator',
      '#| the entry point,\n   #| nested |# and all |#',
      '#;(display (add 1 2))',
    ])
  })

  it('reads character literals, named ones included', () => {
    expect(textFor({ spec, source, group: 'character' })).toEqual([
      '#\\a',
      '#\\b',
      '#\\c',
      '#\\space',
    ])
  })

  it('reads the boolean literals as builtin constants', () => {
    expect(textFor({ spec, source, group: 'constant.builtin' })).toEqual(['#f', '#true'])
  })

  it('reads signed and rational numbers', () => {
    expect(textFor({ spec, source, group: 'number' })).toEqual([
      '0',
      '2',
      '3',
      '5',
      '7',
      '2',
      '1',
      '2',
      '5',
      '-3',
      '1/2',
    ])
  })

  it('reads radix-prefixed, exactness-prefixed and signed hash numbers whole', () => {
    const hashed = '(display #xff) (display #b1010) (display #e-1.5) (display #x-1f) (display #i1/3)'
    expect(textFor({ spec, source: hashed, group: 'number' })).toEqual([
      '#xff',
      '#b1010',
      '#e-1.5',
      '#x-1f',
      '#i1/3',
    ])
  })

  it('reads the signed infinities and nan as numbers', () => {
    const infinities = '(display (+ +inf.0 -inf.0 +nan.0))'
    expect(textFor({ spec, source: infinities, group: 'number' })).toEqual([
      '+inf.0',
      '-inf.0',
      '+nan.0',
    ])
  })

  it('leaves an infinity-prefixed name plain, because only the literal is a number', () => {
    expectPlain({ spec, source: '(define -infinity 0)', text: '-infinity' })
  })

  it('carries a datum comment over a datum nested two deep', () => {
    const nested = '#;(if (= x 0) (error "zero") (/ 1 x))\n(display x)'
    expect(textFor({ spec, source: nested, group: 'comment' })).toEqual([
      '#;(if (= x 0) (error "zero") (/ 1 x))',
    ])
  })

  it('reads arithmetic and predicate names as builtin procedures', () => {
    const builtins = textFor({ spec, source, group: 'function.builtin' })
    expect(builtins).toContain('+')
    expect(builtins).toContain('*')
    expect(builtins).toContain('=')
    expect(builtins).toContain('null?')
    expect(builtins).toContain('display')
  })

  it('emits no operator group, because arithmetic names are identifiers here', () => {
    expect([...groupsIn({ spec, source })]).not.toContain('operator')
  })

  it('reads only the double-quoted text as a string', () => {
    expect(textFor({ spec, source, group: 'string' })).toEqual(['"scale must not be zero"'])
  })

  it('leaves a quoted list alone rather than opening a string at the apostrophe', () => {
    expectPlain({ spec, source, text: "'(2 3 5 7)" })
  })

  it('leaves a hyphenated user-defined name whole and uncoloured', () => {
    expectPlain({ spec, source, text: 'calculator-multiply' })
  })

  it('keeps an angle-bracketed record name whole rather than colouring its brackets', () => {
    expectPlain({ spec, source, text: '<calculator>' })
  })

  it('leaves the syntax-rules ellipsis plain', () => {
    expectPlain({ spec, source: '(syntax-rules () ((_ e ...) (begin e ...)))', text: '...' })
  })

  it('answers to the scm and ss aliases too', () => {
    expect(spec.aliases).toContain('scm')
    expect(spec.aliases).toContain('ss')
  })
})
