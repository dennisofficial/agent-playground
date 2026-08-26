import { describe, expect, it } from 'bun:test'

import { expectLexes, expectPlain, textFor } from '../../__tests__/harness'
import { d as spec } from '../d'

const source = [
  'module calc;',
  '',
  'import std.stdio;',
  '',
  '/+ the reference program',
  '   /+ this nested note stays inside the comment +/',
  '   and the outer comment keeps going',
  '+/',
  'int add(int a, int b) @safe pure nothrow',
  '{',
  '    return a + b;',
  '}',
  '',
  '/* a scaled multiplier */',
  'struct Calculator',
  '{',
  '    private int scale = 1;',
  '',
  '    int multiply(int x, int y) const @nogc',
  '    {',
  '        return x * y * scale;  // the scaled product',
  '    }',
  '}',
  '',
  'void main()',
  '{',
  '    auto calc = Calculator();',
  '    immutable total = add(2, 3);',
  '    auto path = r"C:\\raw\\";',
  '    string label = `total: ` ~ "\\n";',
  "    char tick = 'x';",
  '',
  '    if (path is null)',
  '        return;',
  '',
  '    foreach (i; 0 .. 3)',
  '        writeln(label, calc.multiply(total, i + 1), path, tick);',
  '',
  '    static if (size_t.sizeof == 8)',
  '        writeln("64-bit", 0x1F, 1_000_000, 2.5f);',
  '}',
  '',
  'unittest',
  '{',
  '    assert(add(1, 2) == 3);',
  '}',
  '',
].join('\n')

describe('d lexical highlighting', () => {
  it('lexes a representative sample', () => {
    expectLexes({
      spec,
      source,
      groups: [
        'comment',
        'string',
        'character',
        'keyword',
        'conditional',
        'storageclass',
        'type.qualifier',
        'type',
        'attribute',
        'function.call',
        'function.builtin',
        'number',
        'constant.builtin',
        'operator',
      ],
    })
  })

  it('keeps a nested /+ +/ comment whole', () => {
    const nesting = 'int x = 1;\n/+ outer /+ inner +/ still outer +/\nint y = 2;\n'
    expect(textFor({ spec, source: nesting, group: 'comment' })).toEqual([
      '/+ outer /+ inner +/ still outer +/',
    ])
    expectPlain({ spec, source: nesting, text: 'y = 2' })
  })

  it('closes a /* */ comment at the first delimiter because it does not nest', () => {
    const inner = '/* outer /* inner */ int later;'
    expect(textFor({ spec, source: inner, group: 'comment' })).toEqual(['/* outer /* inner */'])
    expect(textFor({ spec, source: inner, group: 'type' })).toEqual(['int'])
  })

  it('reads wysiwyg and escaped strings alike', () => {
    expect(textFor({ spec, source, group: 'string' })).toEqual([
      'r"C:\\raw\\"',
      '`total: `',
      '"\\n"',
      '"64-bit"',
    ])
  })

  it('reads a character literal apart from a string', () => {
    expect(textFor({ spec, source, group: 'character' })).toEqual(["'x'"])
  })

  it('reads function attributes as attributes', () => {
    expect(textFor({ spec, source, group: 'attribute' })).toEqual(['@safe', '@nogc'])
  })

  it('separates qualifiers from storage classes', () => {
    expect(textFor({ spec, source, group: 'type.qualifier' })).toEqual([
      'pure',
      'nothrow',
      'const',
      'immutable',
    ])
    expect(textFor({ spec, source, group: 'storageclass' })).toEqual([
      'private',
      'auto',
      'auto',
      'static',
    ])
  })

  it('reads called names and std.stdio output apart', () => {
    expect(textFor({ spec, source, group: 'function.call' })).toEqual([
      'add',
      'multiply',
      'main',
      'add',
      'multiply',
      'add',
    ])
    expect(textFor({ spec, source, group: 'function.builtin' })).toEqual(['writeln', 'writeln'])
  })

  it('reads suffixed and separated numbers whole', () => {
    expect(textFor({ spec, source, group: 'number' })).toEqual([
      '1',
      '2',
      '3',
      '0',
      '3',
      '1',
      '8',
      '0x1F',
      '1_000_000',
      '2.5f',
      '1',
      '2',
      '3',
    ])
  })

  it('does not let a trailing backslash escape out of a wysiwyg string', () => {
    expectPlain({ spec, source, text: 'label =' })
  })

  it('reads an octal literal whole', () => {
    const octal = 'int mode = 0o755;'
    expect(textFor({ spec, source: octal, group: 'number' })).toEqual(['0o755'])
    expectPlain({ spec, source: octal, text: 'mode' })
  })

  it('keeps a q"..." delimited string in one piece across its lines', () => {
    const heredoc = 'auto banner = q"EOS\nusage: calc\nEOS";\nint after;\n'
    expect(textFor({ spec, source: heredoc, group: 'string' })).toEqual([
      'q"EOS\nusage: calc\nEOS"',
    ])
    expect(textFor({ spec, source: heredoc, group: 'type' })).toEqual(['int'])
  })

  it('leaves a variable named q alone', () => {
    expectPlain({ spec, source: 'auto q = queue.front;', text: 'q =' })
  })

  it('reads the special file and line tokens as builtin constants', () => {
    const special = 'writeln(__FILE__, __LINE__);'
    expect(textFor({ spec, source: special, group: 'constant.builtin' })).toEqual([
      '__FILE__',
      '__LINE__',
    ])
  })

  it('answers to the dlang alias too', () => {
    expect(spec.aliases).toContain('dlang')
  })

  it('keeps a url inside a string out of the line comment', () => {
    const url = 'auto site = "https://dlang.org";'
    expect(textFor({ spec, source: url, group: 'string' })).toEqual(['"https://dlang.org"'])
    expect(textFor({ spec, source: url, group: 'comment' })).toEqual([])
  })
})
