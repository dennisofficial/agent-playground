import {
  blockComment,
  doubleQuoted,
  lineComment,
  pattern,
  preprocessor,
  quoted,
  tripleQuoted,
} from '../rules'
import type { LanguageSpec } from '../spec'

export const fsharp: LanguageSpec = {
  filetype: 'fsharp',
  aliases: ['f#', 'fs', 'fsx'],
  call: 'function.call',
  rules: [
    blockComment({ open: '(*', close: '*)', nests: true }),
    lineComment({ open: '//' }),
    pattern({ match: /\[<[^>\n]*>\]/, group: 'attribute' }),
    preprocessor(),
    tripleQuoted(),
    quoted({ open: '@"', close: '"', escape: null, doubled: true }),
    quoted({ open: '$"', close: '"' }),
    doubleQuoted(),
    pattern({ match: /'(?:\\(?:u[0-9A-Fa-f]{4}|.)|[^'\\\n])'B?/, group: 'character' }),
    pattern({ match: /'[A-Za-z_][A-Za-z0-9_]*/, group: 'type' }),
    pattern({ match: /(?:Some|None|Ok|Error)(?![A-Za-z0-9_'.])/, group: 'constructor' }),
    pattern({ match: /(?<=\.)[A-Z][A-Za-z0-9_]*'*(?=[ \t]*\()/, group: 'function.call' }),
    pattern({ match: /[A-Z][A-Za-z0-9_]*'*/, group: 'type' }),
  ],
  identifier: /[A-Za-z_][A-Za-z0-9_]*'*/,
  number:
    /(?:0[xX][0-9A-Fa-f_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)(?:[uU][yYsSlLnN]?|[yYsSlLnN]|[fFmMI])?/,
  operators: '+-*/%<>=!&|^~@:?',
  words: {
    keyword: [
      'abstract', 'and', 'as', 'assert', 'async', 'base', 'begin', 'class', 'default', 'delegate',
      'do', 'done', 'downcast', 'downto', 'elif', 'else', 'end', 'exception', 'extern', 'finally',
      'for', 'fun', 'function', 'global', 'if', 'in', 'inherit', 'inline', 'interface', 'internal',
      'lazy', 'let', 'match', 'member', 'module', 'mutable', 'namespace', 'new', 'not', 'of', 'open',
      'or', 'override', 'private', 'public', 'raise', 'rec', 'return', 'sealed', 'static', 'struct',
      'task', 'then', 'to', 'try', 'type', 'upcast', 'use', 'val', 'when', 'while', 'with', 'yield',
    ],
    type: [
      'array', 'bigint', 'bool', 'byte', 'char', 'decimal', 'double', 'exn', 'float', 'float32',
      'int', 'int16', 'int32', 'int64', 'list', 'nativeint', 'obj', 'option', 'sbyte', 'seq',
      'single', 'string', 'uint', 'uint16', 'uint32', 'uint64', 'unit', 'voption',
    ],
    'constant.builtin': ['true', 'false', 'null'],
    'function.builtin': [
      'box', 'defaultArg', 'eprintf', 'eprintfn', 'failwith', 'failwithf', 'fprintfn', 'ignore',
      'fst', 'snd', 'nameof', 'printf', 'printfn', 'sprintf', 'typeof', 'unbox',
    ],
  },
}
