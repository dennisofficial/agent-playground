import { describe, expect, it } from 'bun:test'

import { expectLexes, expectPlain, groupsIn, textFor } from '../../__tests__/harness'
import { groovy as spec } from '../groovy'

const source = [
  '#!/usr/bin/env groovy',
  '// a calculator',
  'package demo',
  '',
  'import groovy.transform.CompileStatic',
  '',
  '@CompileStatic',
  'class Calculator {',
  '    private final BigDecimal scale',
  '',
  '    Calculator(BigDecimal scale) {',
  '        this.scale = scale',
  '    }',
  '',
  '    @Override',
  '    String toString() { "Calculator(${scale})" }',
  '',
  '    BigDecimal multiply(BigDecimal x, BigDecimal y) {',
  '        assert x != null && y != null',
  '        return x * y * scale',
  '    }',
  '}',
  '',
  'def add(int a, int b) {',
  '    a + b',
  '}',
  '',
  'def calc = new Calculator(2.5G)',
  'def numbers = [1, 2, 3]',
  'def doubled = numbers.collect { it * 2 }',
  'def iterator = numbers.iterator()',
  "def banner = '''plain",
  "text'''",
  '',
  'try {',
  '    println "sum is ${add(5, 3)} and ${calc.multiply(4, 6)}"',
  '    println banner + doubled + iterator.hasNext()',
  '} catch (ArithmeticException e) {',
  "    println 'failed: ' + e.message",
  '} finally {',
  '    println "bye"',
  '}',
  '',
].join('\n')

describe('groovy lexical highlighting', () => {
  it('lexes a representative sample', () => {
    expectLexes({
      spec,
      source,
      groups: [
        'comment',
        'string',
        'keyword',
        'type',
        'type.builtin',
        'attribute',
        'function.call',
        'function.builtin',
        'number',
        'constant.builtin',
        'variable.builtin',
        'operator',
      ],
    })
  })

  it('reads the implicit closure parameter as a keyword', () => {
    expect(textFor({ spec, source: 'nums.collect { it * 2 }', group: 'keyword' })).toEqual(['it'])
  })

  it('reads annotations as attributes', () => {
    expect(textFor({ spec, source, group: 'attribute' })).toEqual(['@CompileStatic', '@Override'])
  })

  it('reads a grab annotation on an import as an attribute', () => {
    const grab = [
      "@Grab('org.apache.commons:commons-math3:3.6.1')",
      'import org.apache.commons.math3.util.Precision',
    ].join('\n')
    expect(textFor({ spec, source: grab, group: 'attribute' })).toEqual(['@Grab'])
  })

  it('reads a script shebang as a comment', () => {
    expect(textFor({ spec, source, group: 'comment' })).toEqual([
      '#!/usr/bin/env groovy',
      '// a calculator',
    ])
  })

  it('reads a triple-quoted gstring as one string', () => {
    expect(textFor({ spec, source: 'def s = """a ${b}\nc"""', group: 'string' })).toEqual([
      '"""a ${b}\nc"""',
    ])
  })

  it('reads a triple-single-quoted block as one string', () => {
    expect(textFor({ spec, source: "def s = '''a\nb'''", group: 'string' })).toEqual(["'''a\nb'''"])
  })

  it('reads numeric suffixes as part of the number', () => {
    expect(textFor({ spec, source: 'def big = 2.5G + 10L + 1.5d', group: 'number' })).toEqual([
      '2.5G',
      '10L',
      '1.5d',
    ])
  })

  it('reads a capitalised name as a type and a primitive as a builtin type', () => {
    expect(textFor({ spec, source: 'int n = new BigDecimal("2").intValue()', group: 'type' }))
      .toEqual(['BigDecimal'])
    expect(textFor({ spec, source: 'int n = new BigDecimal("2").intValue()', group: 'type.builtin' }))
      .toEqual(['int'])
  })

  it('reads a range as two numbers rather than one', () => {
    expect(textFor({ spec, source: '(1..10).each { println it }', group: 'number' })).toEqual([
      '1',
      '10',
    ])
  })

  it('reads division as an operator, not the start of a comment', () => {
    expect(groupsIn({ spec, source: 'def mean = total / count' })).not.toContain('comment')
    expect(textFor({ spec, source: 'def mean = total / count', group: 'operator' })).toEqual([
      '=',
      '/',
    ])
  })

  it('leaves a direct field access alone rather than reading it as an annotation', () => {
    const access = 'def raw = calc.@scale'
    expect(groupsIn({ spec, source: access })).not.toContain('attribute')
    expectPlain({ spec, source: access, text: '@scale' })
  })

  it('leaves a keyword that only prefixes a longer identifier alone', () => {
    expectPlain({ spec, source, text: 'iterator' })
  })

  it('leaves an ordinary field name alone', () => {
    expectPlain({ spec, source, text: 'scale' })
  })
})
