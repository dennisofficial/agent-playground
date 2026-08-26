import { describe, expect, it } from 'bun:test'

import { expectLexes, expectPlain, groupsIn, textFor } from '../../__tests__/harness'
import { swift as spec } from '../swift'

const source = [
  '// a calculator',
  'import Foundation',
  '',
  '/* outer /* inner */ still comment */',
  '',
  '@MainActor',
  'struct Calculator {',
  '    let scale: Double',
  '    var cached: Int? = nil',
  '',
  '    func add(_ x: Int, _ y: Int) -> Int {',
  '        return x + y',
  '    }',
  '',
  '    func multiply(x: Double, y: Double) -> Double {',
  '        guard scale != 0 else { return 0 }',
  '        return x * y * self.scale',
  '    }',
  '',
  '    static func unit() -> Self {',
  '        return Self(scale: 1.0)',
  '    }',
  '',
  '    func describe(using format: @escaping (Double) -> String) -> String {',
  '        return """',
  '        scale \\(scale)',
  '        """',
  '    }',
  '}',
  '',
  'extension Calculator {',
  '    static let `default` = Calculator(scale: 1.0)',
  '}',
  '',
  'let variance = 0.5',
  'let digits = #"\\d+(\\.\\d+)?"#',
  'let calculator = Calculator(scale: 2.0)',
  'let sums = [1, 2, 3].map { calculator.add($0, 1) }',
  'if #available(macOS 12, *) {',
  '    print("product \\(calculator.multiply(x: 5.0, y: 3.0)) \\(sums)", terminator: "\\n")',
  '}',
  '',
].join('\n')

describe('swift lexical highlighting', () => {
  it('lexes a representative sample', () => {
    expectLexes({
      spec,
      source,
      groups: [
        'comment',
        'string',
        'keyword',
        'keyword.directive',
        'type',
        'attribute',
        'constant.builtin',
        'function.call',
        'number',
        'operator',
        'variable',
      ],
    })
  })

  it('reads a compiler directive as a directive keyword', () => {
    expect(textFor({ spec, source, group: 'keyword.directive' })).toEqual(['#available'])
  })

  it('leaves the arguments of a directive to the rest of the pass', () => {
    expectPlain({ spec, source, text: 'macOS' })
  })

  it('reads attributes as attributes', () => {
    expect(textFor({ spec, source, group: 'attribute' })).toEqual(['@MainActor', '@escaping'])
  })

  it('closes a nested block comment at the outer delimiter', () => {
    expect(textFor({ spec, source, group: 'comment' })).toEqual([
      '// a calculator',
      '/* outer /* inner */ still comment */',
    ])
  })

  it('reads Self alongside the lowercase builtins', () => {
    expect(textFor({ spec, source, group: 'constant.builtin' })).toEqual([
      'nil',
      'self',
      'Self',
      'Self',
    ])
  })

  it('reads the shorthand closure argument and a backticked name as variables', () => {
    expect(textFor({ spec, source, group: 'variable' })).toEqual(['`default`', '$0'])
  })

  it('reads a projected property wrapper as one variable', () => {
    expect(
      textFor({ spec, source: 'TextField("name", text: $viewModel.name)', group: 'variable' }),
    ).toEqual(['$viewModel'])
  })

  it('never reads a shorthand argument as a number', () => {
    expect(groupsIn({ spec, source: 'items.sorted { $0.id < $1.id }' })).toEqual(
      new Set(['variable', 'operator']),
    )
  })

  it('reads a raw string whole, extended delimiters included', () => {
    expect(textFor({ spec, source, group: 'string' })).toEqual([
      '"""\n        scale \\(scale)\n        """',
      '#"\\d+(\\.\\d+)?"#',
      '"product \\(calculator.multiply(x: 5.0, y: 3.0)) \\(sums)"',
      '"\\n"',
    ])
  })

  it('reads a multiline literal as one string, interpolation included', () => {
    expect(
      textFor({
        spec,
        source: ['let note = """', 'scale \\(scale)', '"""', 'let unit = "cm"'].join('\n'),
        group: 'string',
      }),
    ).toEqual(['"""\nscale \\(scale)\n"""', '"cm"'])
  })

  it('reads capitalised names as types and leaves lowercase names to the words table', () => {
    expect(textFor({ spec, source, group: 'type' })).toEqual([
      'Foundation',
      'Calculator',
      'Double',
      'Int',
      'Int',
      'Int',
      'Int',
      'Double',
      'Double',
      'Double',
      'Double',
      'String',
      'String',
      'Calculator',
      'Calculator',
      'Calculator',
    ])
  })

  it('leaves optional-type sugar uncoloured', () => {
    expectPlain({ spec, source, text: '?' })
  })

  it('never matches a keyword inside a longer identifier', () => {
    expectPlain({ spec, source, text: 'variance' })
    expect(groupsIn({ spec, source: 'let deferred = 1' })).toEqual(
      new Set(['keyword', 'operator', 'number']),
    )
  })
})
