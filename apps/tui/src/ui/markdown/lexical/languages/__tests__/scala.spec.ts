import { describe, expect, it } from 'bun:test'

import { expectLexes, expectPlain, groupsIn, textFor } from '../../__tests__/harness'
import { scala as spec } from '../scala'

const source = [
  '// a calculator',
  'import scala.annotation.tailrec',
  '',
  'object Calculator {',
  '  /* the default scaling */',
  '  val scale: Int = 2',
  '  val maxScale = 10',
  '  val limit: Long = 100L',
  '  val enabled: Boolean = true',
  "  val initial = 'C'",
  '  val banner = """Calculator',
  'ready"""',
  '  val tabbed = raw"$scale\\tunits"',
  '  val name: Option[String] = None',
  '',
  '  def add(x: Int, y: Int): Int = x + y',
  '',
  '  def multiply(x: Int, y: Int): Int = x * y * scale',
  '',
  '  @tailrec',
  '  def sumAll(xs: List[Int], acc: Int): Int = xs match {',
  '    case Nil => acc',
  '    case h :: t => sumAll(t, acc + h)',
  '  }',
  '}',
  '',
  'object Main {',
  '  def main(args: Array[String]): Unit = {',
  '    val total = Calculator.add(2, 3)',
  '    println(s"total = $total, product = ${Calculator.multiply(5, 3)}")',
  '    println("done")',
  '  }',
  '}',
  '',
].join('\n')

describe('scala lexical highlighting', () => {
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
        'attribute',
        'function.call',
        'function.builtin',
        'constant.builtin',
        'number',
        'operator',
      ],
    })
  })

  it('reads every interpolator prefix as part of its string', () => {
    expect(textFor({ spec, source, group: 'string' })).toEqual([
      '"""Calculator\nready"""',
      'raw"$scale\\tunits"',
      's"total = $total, product = ${Calculator.multiply(5, 3)}"',
      '"done"',
    ])
  })

  it('reads a triple-quoted interpolation whole', () => {
    expect(textFor({ spec, source: 'val q = s"""a\nb"""', group: 'string' })).toEqual([
      's"""a\nb"""',
    ])
  })

  it('reads both comment forms', () => {
    expect(textFor({ spec, source, group: 'comment' })).toEqual([
      '// a calculator',
      '/* the default scaling */',
    ])
  })

  it('closes a nested block comment at the outer delimiter', () => {
    const nested = '/* outer /* inner */ still */ val a = 1'
    expect(textFor({ spec, source: nested, group: 'comment' })).toEqual([
      '/* outer /* inner */ still */',
    ])
    expect(textFor({ spec, source: nested, group: 'operator' })).toEqual(['='])
  })

  it('reads an uppercase-initial name as a type', () => {
    const types = textFor({ spec, source, group: 'type' })
    expect(types).toContain('Calculator')
    expect(types).toContain('Int')
    expect(types).toContain('Option')
  })

  it('reads None and Nil as builtin constants alongside the lowercase literals', () => {
    expect(textFor({ spec, source, group: 'constant.builtin' })).toEqual(['true', 'None', 'Nil'])
  })

  it('reads a char literal as a character, not an unterminated string', () => {
    expect(textFor({ spec, source, group: 'character' })).toEqual(["'C'"])
  })

  it('reads an annotation as an attribute', () => {
    expect(textFor({ spec, source, group: 'attribute' })).toEqual(['@tailrec'])
  })

  it('swallows a literal type suffix into the number', () => {
    expect(textFor({ spec, source, group: 'number' })).toContain('100L')
    expect(textFor({ spec, source, group: 'type' })).not.toContain('L')
    expect(textFor({ spec, source: 'val m = 0xFFL + 2.5f', group: 'number' })).toEqual([
      '0xFFL',
      '2.5f',
    ])
  })

  it('leaves the dotted import path plain', () => {
    expectPlain({ spec, source, text: 'tailrec' })
  })

  it('leaves a camel-cased local plain', () => {
    expectPlain({ spec, source, text: 'maxScale' })
  })

  it('needs the quote adjacent for an interpolator prefix', () => {
    expect(groupsIn({ spec, source: 'val f = 1' })).not.toContain('string')
  })

  it('keeps a keyword that abuts a string literal', () => {
    const abutting = 'x match { case"a" => 1 }'
    expect(textFor({ spec, source: abutting, group: 'keyword' })).toEqual(['match', 'case'])
    expect(textFor({ spec, source: abutting, group: 'string' })).toEqual(['"a"'])
  })

  it('answers to the sc and sbt aliases too', () => {
    expect(spec.aliases).toContain('sc')
    expect(spec.aliases).toContain('sbt')
  })
})
