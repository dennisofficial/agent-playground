import { describe, expect, it } from 'bun:test'

import { expectLexes, expectPlain, groupsIn, textFor } from '../../__tests__/harness'
import { nim as spec } from '../nim'

const source = [
  '##[ A tiny calculator, in Nim.',
  '    Doc block comments nest: ##[ like this ]##',
  ']##',
  '## the line form is a doc comment too',
  '#[ the plain block form nests as well',
  '   #[ so this inner one closes first ]#',
  ']#',
  'import std/strformat',
  '',
  'type Calculator = ref object',
  '  scale: int',
  '',
  'proc add(a, b: int): int {.inline.} =',
  '  result = a + b',
  '',
  'method multiply(self: Calculator; x, y: int): int {.base.} =',
  '  result = x * y * self.scale',
  '',
  'proc describe(c: Calculator): string =',
  '  let tag = \'C\'',
  '  var parts = newSeq[string]()',
  '  parts.add(&"{tag}:{c.scale}")',
  '  if parts.len == 0:',
  '    discard',
  '  return """',
  '  a raw report',
  '  """',
  '',
  'let calc = Calculator(scale: 2)',
  'let byteVal = 255\'u8',
  'let root = r"C:\\atlas\\" & "bin"',
  'echo add(2, 3)',
  'echo calc.multiply(5, 3)',
  'echo describe(calc)',
  'echo byteVal, root',
  '',
].join('\n')

describe('nim lexical highlighting', () => {
  it('lexes a representative sample', () => {
    expectLexes({
      spec,
      source,
      groups: [
        'comment',
        'string',
        'character',
        'attribute',
        'keyword',
        'type',
        'number',
        'operator',
        'function.call',
        'function.builtin',
        'constant.builtin',
      ],
    })
  })

  it('reads a pragma as an attribute', () => {
    expect(textFor({ spec, source, group: 'attribute' })).toEqual(['{.inline.}', '{.base.}'])
  })

  it('keeps every comment form whole, nesting included', () => {
    const comments = textFor({ spec, source, group: 'comment' })
    expect(comments).toHaveLength(3)
    expect(comments[0]).toStartWith('##[ A tiny calculator')
    expect(comments[0]).toEndWith('\n]##')
    expect(comments[1]).toBe('## the line form is a doc comment too')
    expect(comments[2]).toStartWith('#[ the plain block form')
    expect(comments[2]).toEndWith('\n]#')
  })

  it('does not let the hash line comment swallow a doc block opener', () => {
    const docBlock = '##[ docs\nlet hidden = 1\n]##\nlet shown = 2\n'
    expect(textFor({ spec, source: docBlock, group: 'comment' })).toEqual([
      '##[ docs\nlet hidden = 1\n]##',
    ])
    expect(textFor({ spec, source: docBlock, group: 'keyword' })).toEqual(['let'])
  })

  it('reads a triple-quoted string across lines and a single-quoted char apart from it', () => {
    expect(textFor({ spec, source, group: 'string' })).toEqual([
      '"{tag}:{c.scale}"',
      '"""\n  a raw report\n  """',
      'r"C:\\atlas\\"',
      '"bin"',
    ])
    expect(textFor({ spec, source, group: 'character' })).toEqual(["'C'"])
  })

  it('stops a raw string at its own closing quote despite the trailing backslash', () => {
    expect(textFor({ spec, source: 'let p = r"C:\\dir\\" & name', group: 'string' })).toEqual([
      'r"C:\\dir\\"',
    ])
    expect(textFor({ spec, source: 'let q = re"[a-z]+"', group: 'string' })).toEqual(['re"[a-z]+"'])
  })

  it('reads the implicit result variable as a builtin constant', () => {
    expect(textFor({ spec, source, group: 'constant.builtin' })).toEqual(['result', 'result'])
  })

  it('reads a parenthesised name as a call and echo as a builtin', () => {
    expect(textFor({ spec, source, group: 'function.call' })).toEqual([
      'multiply',
      'describe',
      'Calculator',
      'multiply',
      'describe',
    ])
    expect(textFor({ spec, source, group: 'function.builtin' }).filter((name) => name === 'echo'))
      .toHaveLength(4)
  })

  it('leaves a custom numeric literal suffix uncoloured', () => {
    expectPlain({ spec, source, text: "'u8" })
  })

  it('leaves an identifier that merely precedes a string alone', () => {
    expectPlain({ spec, source: 'echo prefix, "tail"', text: 'prefix' })
  })

  it('does not read a hash inside a string as a comment', () => {
    expect(groupsIn({ spec, source: 'echo "count # 3"' })).toEqual(
      new Set(['function.builtin', 'string']),
    )
  })

  it('answers to the nims alias too', () => {
    expect(spec.aliases).toContain('nims')
  })
})
