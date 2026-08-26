import { describe, expect, it } from 'bun:test'

import { expectLexes, expectPlain, textFor } from '../../__tests__/harness'
import { dart as spec } from '../dart'

const source = [
  '/// A pocket calculator.',
  "import 'dart:math' as math;",
  '',
  'int add(int a, int b) => a + b;',
  '',
  '/* Sealed in Dart 3; left open here. */',
  'class Calculator {',
  '  Calculator(this.scale);',
  '',
  '  final int scale;',
  "  static const String label = 'calc';",
  '',
  '  double multiply(num x, num y) {',
  '    assert(scale > 0);',
  '    return math.max(x * y * scale, 0).toDouble();',
  '  }',
  '}',
  '',
  'class Doubler extends Calculator {',
  '  Doubler() : super(2);',
  '',
  '  @override',
  '  double multiply(num x, num y) => super.multiply(x, y) * 2;',
  '}',
  '',
  'Future<void> main() async {',
  '  final calc = Doubler();',
  '  const raw = r"a \\n b";',
  "  final banner = '''== ${Calculator.label} ==''';",
  '  final digits = RegExp(r\'\'\'^\\d+$\'\'\');',
  '  print("${add(2, 3)} $banner $raw ${calc.multiply(5, 3)}");',
  "  print(digits.hasMatch('12') ? 'ok' : 'no');",
  '  await Future<void>.delayed(Duration.zero);',
  '}',
  '',
].join('\n')

describe('dart lexical highlighting', () => {
  it('lexes a representative sample', () => {
    expectLexes({
      spec,
      source,
      groups: [
        'comment',
        'string',
        'keyword',
        'type',
        'attribute',
        'constant.builtin',
        'function.call',
        'function.builtin',
        'number',
        'operator',
      ],
    })
  })

  it('reads a doc comment and a block comment as comments', () => {
    expect(textFor({ spec, source, group: 'comment' })).toEqual([
      '/// A pocket calculator.',
      '/* Sealed in Dart 3; left open here. */',
    ])
  })

  it('reads raw, triple-quoted and interpolated strings whole', () => {
    expect(textFor({ spec, source, group: 'string' })).toEqual([
      "'dart:math'",
      "'calc'",
      'r"a \\n b"',
      "'''== ${Calculator.label} =='''",
      "r'''^\\d+$'''",
      '"${add(2, 3)} $banner $raw ${calc.multiply(5, 3)}"',
      "'12'",
      "'ok'",
      "'no'",
    ])
  })

  it('reads an annotation as an attribute', () => {
    expect(textFor({ spec, source, group: 'attribute' })).toEqual(['@override'])
  })

  it('reads a raw triple-quoted regex as one string, not three', () => {
    expect(textFor({ spec, source: "final r = RegExp(r'''^\\d+$''');", group: 'string' })).toEqual([
      "r'''^\\d+$'''",
    ])
  })

  it('reads the null-safety operators as operators', () => {
    expect(textFor({ spec, source: 'int? a = b ?? c; a ??= d; a?.hash;', group: 'operator' })).toEqual([
      '?',
      '=',
      '??',
      '??=',
      '?',
    ])
  })

  it('reads a dollar-bearing identifier whole', () => {
    expect(textFor({ spec, source: 'final _$Gen = 2;', group: 'type' })).toEqual([])
  })

  it('reads capitalised names as types', () => {
    expect(textFor({ spec, source, group: 'type' })).toEqual([
      'int',
      'int',
      'int',
      'Calculator',
      'Calculator',
      'int',
      'String',
      'double',
      'num',
      'num',
      'Doubler',
      'Calculator',
      'Doubler',
      'double',
      'num',
      'num',
      'Future',
      'void',
      'Doubler',
      'RegExp',
      'Future',
      'void',
      'Duration',
    ])
  })

  it('reads the modifier pile-up as keywords', () => {
    expect(textFor({ spec, source: 'late final num total = 0;', group: 'keyword' })).toEqual([
      'late',
      'final',
    ])
  })

  it('leaves an ordinary local alone', () => {
    expectPlain({ spec, source, text: 'calc = ' })
  })

  it('does not read a lone r as a raw string prefix', () => {
    expectPlain({ spec, source: 'var r = add(1, 2);', text: 'r =' })
  })

  it('does not find a keyword inside a dollar-bearing identifier', () => {
    expectPlain({ spec, source: 'var x$var = 1;', text: 'x$var' })
    expect(textFor({ spec, source: 'var x$var = 1;', group: 'keyword' })).toEqual(['var'])
  })
})
