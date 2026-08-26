import { describe, expect, it } from 'bun:test'

import { expectLexes, expectPlain, groupsIn, textFor } from '../../__tests__/harness'
import { fsharp as spec } from '../fsharp'

const source = [
  '// a calculator',
  'module Calc.Program',
  '',
  'open System',
  '',
  'let add (x: int) (y: int) : int = x + y',
  '',
  "let inline pair (a: 'T) (b: 'T) : 'T * 'T = (a, b)",
  '',
  'type Calculator(scale: float) =',
  '    let mutable built = 0',
  '    member this.Multiply(x: float, y: float) =',
  '        built <- built + 1',
  '        x * y * scale',
  '',
  'let describe (value: int option) : string =',
  '    match value with',
  '    | Some n when n > 0 -> sprintf "positive %d" n',
  '    | Some _ -> "non-positive"',
  '    | None -> "nothing"',
  '',
  '(* the shipped entry point *)',
  '[<EntryPoint>]',
  'let main argv =',
  '    let calc = Calculator(2.0)',
  '    let names : string list = [ "a"; "b" ]',
  '    let scales = [| 1.0; 2.0 |]',
  "    let grade = 'A'",
  '    let path = @"C:\\logs\\out.txt"',
  '    let banner = """two',
  'lines"""',
  '    let total\' = add 2 3',
  '    let verbose = false',
  '#if DEBUG',
  '    printfn "argv = %A" argv',
  '#endif',
  '    if verbose then printfn "%s" banner',
  '    let product = calc.Multiply(5.0, 3.0)',
  '    printfn "%d %f" total\' product',
  '    printfn "%s %c %s" (describe (Some 7)) grade path',
  '    printfn "%s" $"names {names} scales {scales}"',
  '    0',
  '',
].join('\n')

describe('fsharp lexical highlighting', () => {
  it('lexes a representative sample', () => {
    expectLexes({
      spec,
      source,
      groups: [
        'comment',
        'string',
        'character',
        'keyword',
        'keyword.directive',
        'type',
        'constructor',
        'attribute',
        'number',
        'operator',
        'function.call',
        'function.builtin',
        'constant.builtin',
      ],
    })
  })

  it('reads a bracket-angle attribute as one attribute', () => {
    expect(textFor({ spec, source, group: 'attribute' })).toEqual(['[<EntryPoint>]'])
  })

  it('reads both comment forms', () => {
    expect(textFor({ spec, source, group: 'comment' })).toEqual([
      '// a calculator',
      '(* the shipped entry point *)',
    ])
  })

  it('nests a block comment', () => {
    const nested = 'let x = (* outer (* inner *) still *) 1'
    expect(textFor({ spec, source: nested, group: 'comment' })).toEqual([
      '(* outer (* inner *) still *)',
    ])
  })

  it('reads a char literal without swallowing a generic parameter or a primed name', () => {
    expect(textFor({ spec, source, group: 'character' })).toEqual(["'A'"])
  })

  it('reads a generic parameter as a type', () => {
    expect(textFor({ spec, source: "let id (a: 'T) : 'T = a", group: 'type' })).toEqual([
      "'T",
      "'T",
    ])
  })

  it('reads verbatim, interpolated and triple-quoted strings whole', () => {
    const strings = [
      'let p = @"C:\\a\\b"',
      'let q = """say "hi" twice"""',
      'let r = $"p is {p}"',
      'let s = "plain \\" escaped"',
    ].join('\n')
    expect(textFor({ spec, source: strings, group: 'string' })).toEqual([
      '@"C:\\a\\b"',
      '"""say "hi" twice"""',
      '$"p is {p}"',
      '"plain \\" escaped"',
    ])
  })

  it('reads numeric literals with their f# suffixes', () => {
    const literals = 'let sizes = (1L, 2.0f, 3M, 0x1Fu, 4uy, 5e3)'
    expect(textFor({ spec, source: literals, group: 'number' })).toEqual([
      '1L',
      '2.0f',
      '3M',
      '0x1Fu',
      '4uy',
      '5e3',
    ])
  })

  it('keeps a range operator off the number', () => {
    expect(textFor({ spec, source: 'for i in 1..10 do ignore i', group: 'number' })).toEqual([
      '1',
      '10',
    ])
  })

  it('reads a compiler directive as a directive', () => {
    expect(textFor({ spec, source, group: 'keyword.directive' })).toEqual(['#if', '#endif'])
  })

  it('reads a primed binding as one identifier', () => {
    expect(groupsIn({ spec, source: "let total' = 1" })).toEqual(
      new Set(['keyword', 'operator', 'number']),
    )
  })

  it('reads a dotted pascal-case method as a call, not a type', () => {
    expect(textFor({ spec, source, group: 'function.call' })).toEqual([
      'add',
      'pair',
      'Multiply',
      'describe',
      'Multiply',
      'describe',
    ])
  })

  it('over-reads a value applied beside a parenthesised argument as a call', () => {
    expect(textFor({ spec, source: 'printfn "%d" total (f 1)', group: 'function.call' })).toEqual([
      'total',
    ])
  })

  it('keeps a constructed type a type while its method is a call', () => {
    const interop = 'Console.WriteLine(Calculator(2.0).Multiply(5.0, 3.0))'
    expect(textFor({ spec, source: interop, group: 'type' })).toEqual(['Console', 'Calculator'])
    expect(textFor({ spec, source: interop, group: 'function.call' })).toEqual([
      'WriteLine',
      'Multiply',
    ])
  })

  it('reads union cases as constructors, not types', () => {
    expect(textFor({ spec, source, group: 'constructor' })).toEqual([
      'Some',
      'Some',
      'None',
      'Some',
    ])
    expect(textFor({ spec, source: 'let r = Error.Message', group: 'type' })).toEqual([
      'Error',
      'Message',
    ])
  })

  it('reads cons, cast and append as operators', () => {
    const symbolic = 'let ys = 1 :: xs @ [ 2 ] |> List.map (fun v -> v :> obj)'
    expect(textFor({ spec, source: symbolic, group: 'operator' })).toEqual([
      '=',
      '::',
      '@',
      '|>',
      '->',
      ':>',
    ])
  })

  it('reads a primed pascal-case name whole', () => {
    expect(textFor({ spec, source: "let Total' = 1", group: 'type' })).toEqual(["Total'"])
  })

  it('leaves an array literal alone', () => {
    expectPlain({ spec, source, text: '[|' })
  })

  it('leaves the self identifier alone', () => {
    expectPlain({ spec, source, text: 'this.Multiply' })
  })

  it('answers to the f# and fsx spellings too', () => {
    expect(spec.aliases).toEqual(['f#', 'fs', 'fsx'])
  })
})
