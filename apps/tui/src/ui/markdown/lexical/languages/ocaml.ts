import { blockComment, doubleQuoted, pattern, quoted } from '../rules'
import type { LanguageSpec } from '../spec'

export const ocaml: LanguageSpec = {
  filetype: 'ocaml',
  aliases: ['ml'],
  rules: [
    blockComment({ open: '(*', close: '*)', nests: true }),
    quoted({ open: '{|', close: '|}', escape: null, multiline: true }),
    doubleQuoted(),
    pattern({
      match: /'(?:\\(?:[\\'"ntbr ]|x[0-9A-Fa-f]{2}|o[0-7]{3}|[0-9]{3})|[^\\'\n])'/,
      group: 'character',
    }),
    pattern({ match: /'[a-z_][A-Za-z0-9_]*/, group: 'type' }),
    pattern({ match: /`[A-Za-z_][A-Za-z0-9_']*/, group: 'constructor' }),
    pattern({ match: /[~?][a-z_][A-Za-z0-9_']*/, group: 'variable.parameter' }),
    pattern({
      match:
        /(?:Some|None|Ok|Error|Exit|Failure|Not_found|Invalid_argument|End_of_file)(?![A-Za-z0-9_'.])/,
      group: 'constructor',
    }),
    pattern({ match: /[A-Z][A-Za-z0-9_']*/, group: 'module' }),
  ],
  identifier: /[a-z_][A-Za-z0-9_']*/,
  number:
    /(?:0[xX][0-9A-Fa-f_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?)[lLn]?/,
  operators: '+-*/%<>=!&|^~@:',
  words: {
    keyword: [
      'and', 'as', 'assert', 'asr', 'begin', 'class', 'constraint', 'do', 'done', 'downto', 'else',
      'end', 'exception', 'external', 'for', 'fun', 'function', 'functor', 'if', 'in', 'include',
      'inherit', 'initializer', 'land', 'lazy', 'let', 'lor', 'lsl', 'lsr', 'lxor', 'match',
      'method', 'mod', 'module', 'mutable', 'new', 'nonrec', 'object', 'of', 'open', 'private',
      'raise', 'rec', 'ref', 'sig', 'struct', 'then', 'to', 'try', 'type', 'val', 'virtual',
      'when', 'while', 'with',
    ],
    boolean: ['true', 'false'],
    'type.builtin': [
      'int', 'float', 'string', 'bool', 'char', 'unit', 'bytes', 'list', 'array', 'option',
      'result', 'exn', 'int32', 'int64', 'nativeint', 'lazy_t',
    ],
    'function.builtin': [
      'abs', 'compare', 'decr', 'failwith', 'float_of_int', 'fst', 'ignore', 'incr',
      'int_of_string', 'invalid_arg', 'max', 'min', 'not', 'pred', 'print_endline', 'print_int',
      'print_newline', 'print_string', 'printf', 'snd', 'sprintf', 'string_of_int', 'succ',
    ],
  },
}
