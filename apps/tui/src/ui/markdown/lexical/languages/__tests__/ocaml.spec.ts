import { describe, expect, it } from 'bun:test'

import { expectLexes, expectPlain, groupsIn, textFor } from '../../__tests__/harness'
import { ocaml as spec } from '../ocaml'

const source = [
  '(* a calculator (* with a nested note *) *)',
  'open Printf',
  '',
  'let add x y = x + y',
  '',
  'module Calculator = struct',
  '  type t = { scale : int; label : string }',
  '',
  '  let make ~scale ?label () =',
  '    { scale; label = Option.value label ~default:"calc" }',
  '',
  '  let multiply t x y =',
  '    if t.scale = 0 then failwith "no scale"',
  '    else x * y * t.scale',
  'end',
  '',
  "let rec length_of : 'a list -> int = function",
  '  | [] -> 0',
  '  | _ :: rest -> 1 + length_of rest',
  '',
  'let render tag =',
  '  match tag with',
  '  | `Total n -> sprintf "total=%d" n',
  '  | `Empty -> {|no value at all|}',
  '',
  'let verbose = false',
  '',
  'let () =',
  '  let calc = Calculator.make ~scale:2 () in',
  "  let grade = 'A' in",
  '  let total = Calculator.multiply calc (add 2 3) 0x2A in',
  '  let names = [ Some "calc"; None ] in',
  '  ignore names;',
  '  printf "%c %d %d\\n" grade total (String.length (render `Empty));',
  '  if verbose then print_endline (render (`Total total)) else print_endline "done"',
  '',
].join('\n')

describe('ocaml lexical highlighting', () => {
  it('lexes a representative sample', () => {
    expectLexes({
      spec,
      source,
      groups: [
        'comment',
        'string',
        'character',
        'type',
        'type.builtin',
        'keyword',
        'boolean',
        'module',
        'constructor',
        'variable.parameter',
        'function.builtin',
        'number',
        'operator',
      ],
    })
  })

  it('closes a nested comment at the outer delimiter', () => {
    expect(textFor({ spec, source, group: 'comment' })).toEqual([
      '(* a calculator (* with a nested note *) *)',
    ])
  })

  it('reads a type variable as a type rather than opening a string', () => {
    const signature = "let swap : 'a * 'b -> 'b * 'a = fun (a, b) -> (b, a)"
    expect(textFor({ spec, source: signature, group: 'type' })).toEqual(["'a", "'b", "'b", "'a"])
    expect(groupsIn({ spec, source: signature })).not.toContain('string')
    expectPlain({ spec, source: signature, text: 'a, b) -> (b' })
  })

  it('keeps a type variable from swallowing a later string on the same line', () => {
    const line = "let name_of : 'a -> string = fun _ -> \"anon\""
    expect(textFor({ spec, source: line, group: 'string' })).toEqual(['"anon"'])
  })

  it('reads a quoted character as a character', () => {
    expect(textFor({ spec, source, group: 'character' })).toEqual(["'A'"])
  })

  it('keeps an escaped quote inside a character literal', () => {
    expect(textFor({ spec, source: "let q = '\\'' and n = '\\n'", group: 'character' })).toEqual([
      "'\\''",
      "'\\n'",
    ])
  })

  it('reads a primed identifier whole and leaves no stray tick', () => {
    const line = "let rest' = 1 in rest' + 1"
    expect(groupsIn({ spec, source: line })).not.toContain('string')
    expectPlain({ spec, source: line, text: "rest' = 1" })
  })

  it('reads every string form, quoted and raw', () => {
    expect(textFor({ spec, source, group: 'string' })).toEqual([
      '"calc"',
      '"no scale"',
      '"total=%d"',
      '{|no value at all|}',
      '"calc"',
      '"%c %d %d\\n"',
      '"done"',
    ])
  })

  it('does not read a comment opener inside a string', () => {
    const line = 'let s = "keep (* this *) literal" in s'
    expect(groupsIn({ spec, source: line })).not.toContain('comment')
  })

  it('stops a raw string at its first closer, which does not nest', () => {
    expect(textFor({ spec, source: 'let r = {|a {| b|} c|}', group: 'string' })).toEqual([
      '{|a {| b|}',
    ])
  })

  it('reads an uppercase-initial name as a module', () => {
    expect(textFor({ spec, source, group: 'module' })).toEqual([
      'Printf',
      'Calculator',
      'Option',
      'Calculator',
      'Calculator',
      'String',
    ])
  })

  it('reads a qualified path off a known constructor name as a module', () => {
    const line = 'let text = Error.to_string e and bad = Error "no"'
    expect(textFor({ spec, source: line, group: 'module' })).toEqual(['Error'])
    expect(textFor({ spec, source: line, group: 'constructor' })).toEqual(['Error'])
  })

  it('reads variant tags and known constructors as constructors', () => {
    expect(textFor({ spec, source, group: 'constructor' })).toEqual([
      '`Total',
      '`Empty',
      'Some',
      'None',
      '`Empty',
      '`Total',
    ])
  })

  it('reads labelled and optional arguments as parameters', () => {
    expect(textFor({ spec, source, group: 'variable.parameter' })).toEqual([
      '~scale',
      '?label',
      '~default',
      '~scale',
    ])
  })

  it('leaves the prefix negation operator to the operator path', () => {
    expect(textFor({ spec, source: 'let n = ~-1 + 2', group: 'operator' })).toEqual(['=', '~-', '+'])
  })

  it('leaves an argument that merely precedes a parenthesis alone', () => {
    expectPlain({ spec, source, text: 'calc (add' })
  })

  it('reads a hexadecimal literal whole', () => {
    expect(textFor({ spec, source, group: 'number' })).toContain('0x2A')
  })

  it('leaves a punned record field alone', () => {
    expectPlain({ spec, source, text: 'scale; label' })
  })

  it('leaves an ordinary local alone', () => {
    expectPlain({ spec, source, text: 'rest ->' })
  })

  it('answers to the ml alias too', () => {
    expect(spec.aliases).toContain('ml')
  })
})
