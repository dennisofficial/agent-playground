import { describe, expect, it } from 'bun:test'

import { expectLexes, expectPlain, groupsIn, textFor } from '../../__tests__/harness'
import { kotlin as spec } from '../kotlin'

const source = [
  '// a calculator',
  'package com.example.calc',
  '',
  'import kotlin.math.abs',
  '',
  'fun add(a: Int, b: Int): Int = a + b',
  '',
  '@Deprecated("use multiply instead")',
  'class Calculator(private val scale: Int = 1) {',
  '  companion object {',
  '    const val NAME = "Calculator"',
  '  }',
  '',
  '  fun multiply(x: Int, y: Int): Int? {',
  '    if (x == 0 || y == 0) return null',
  '    return abs(x * y * scale)',
  '  }',
  '}',
  '',
  'data class Point(val x: Double, val y: Double)',
  '',
  'val banner = """',
  '    |Calculator ready',
  '""".trimMargin()',
  '',
  'fun main() {',
  '  val calc = Calculator(scale = 2)',
  '  val result = calc.multiply(5, 3) ?: 0',
  '  val scaled = result * 1_000_000L',
  '  val isReady = scaled > 0',
  "  val label = 'C'",
  '  listOf(1, 2, 3).forEach { println(it) }',
  '  println("${add(1, 2)} $scaled $isReady $label $banner")',
  '}',
  '',
].join('\n')

describe('kotlin lexical highlighting', () => {
  it('lexes a representative sample', () => {
    expectLexes({
      spec,
      source,
      groups: [
        'comment',
        'string',
        'character',
        'keyword',
        'type',
        'constant',
        'attribute',
        'number',
        'operator',
        'constant.builtin',
        'variable.builtin',
        'function.call',
        'function.builtin',
      ],
    })
  })

  it('reads an annotation as an attribute', () => {
    expect(textFor({ spec, source, group: 'attribute' })).toEqual(['@Deprecated'])
  })

  it('reads a raw string whole, so a triple quote is never an empty string', () => {
    expect(textFor({ spec, source, group: 'string' })).toEqual([
      '"use multiply instead"',
      '"Calculator"',
      '"""\n    |Calculator ready\n"""',
      '"${add(1, 2)} $scaled $isReady $label $banner"',
    ])
  })

  it('keeps a raw string raw, with no escape handling', () => {
    expect(textFor({ spec, source: 'val raw = """a \\b c"""', group: 'string' })).toEqual([
      '"""a \\b c"""',
    ])
  })

  it('reads a char literal as a character', () => {
    expect(textFor({ spec, source, group: 'character' })).toEqual(["'C'"])
  })

  it('reads an escaped quote inside a char literal', () => {
    expect(textFor({ spec, source: "val tick = '\\''", group: 'character' })).toEqual(["'\\''"])
  })

  it('reads a screaming-case name as a constant and a pascal-case one as a type', () => {
    expect(textFor({ spec, source, group: 'constant' })).toEqual(['NAME'])
    expect(textFor({ spec, source: 'val p: Point = Point(1.0, 2.0)', group: 'type' })).toEqual([
      'Point',
      'Point',
    ])
  })

  it('reads a mixed-case exception name as a type, not a constant', () => {
    const throwing = 'throw IOException("gone")'
    expect(textFor({ spec, source: throwing, group: 'type' })).toEqual(['IOException'])
    expect(groupsIn({ spec, source: throwing })).not.toContain('constant')
  })

  it('reads the implicit lambda parameter as a builtin variable', () => {
    expect(textFor({ spec, source, group: 'variable.builtin' })).toEqual(['it'])
  })

  it('reads a safe-call elvis as an operator', () => {
    expect(textFor({ spec, source: 'val n = a?.b ?: 0', group: 'operator' })).toEqual(['=', '?', '?'])
  })

  it('takes a literal suffix as part of the number', () => {
    expect(
      textFor({
        spec,
        source: 'val a = 1_000_000L\nval b = 1.0f\nval c = 0xFFuL\nval d = 255u\nval e = 0b1010',
        group: 'number',
      }),
    ).toEqual(['1_000_000L', '1.0f', '0xFFuL', '255u', '0b1010'])
  })

  it('never reads a literal suffix as a type', () => {
    expect(groupsIn({ spec, source: 'val big = 1_000_000L' })).not.toContain('type')
  })

  it('nests block comments the way kotlin does', () => {
    const nested = '/* outer /* inner */ still comment */\nval x = 1'
    expect(textFor({ spec, source: nested, group: 'comment' })).toEqual([
      '/* outer /* inner */ still comment */',
    ])
    expect(textFor({ spec, source: nested, group: 'operator' })).toEqual(['='])
  })

  it('leaves a comment opener alone inside a string', () => {
    const tricky = 'val u = "https://x /* y */"'
    expect(textFor({ spec, source: tricky, group: 'string' })).toEqual(['"https://x /* y */"'])
    expect(groupsIn({ spec, source: tricky })).not.toContain('comment')
  })

  it('never matches a keyword inside a longer identifier', () => {
    expectPlain({ spec, source, text: 'isReady = scaled' })
    expect(groupsIn({ spec, source: 'val internalValue = 1' })).not.toContain('type')
  })

  it('leaves the common identifier "value" uncoloured', () => {
    expectPlain({ spec, source: 'val v = map.entries.first().value', text: 'value' })
  })

  it('answers to the kt and kts aliases too', () => {
    expect(spec.aliases).toEqual(['kt', 'kts'])
  })
})
