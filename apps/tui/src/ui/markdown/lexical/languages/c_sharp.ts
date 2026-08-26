import {
  doubleQuoted,
  pattern,
  preprocessor,
  quoted,
  slashComments,
  tripleQuoted,
  typeByCase,
} from '../rules'
import type { LanguageSpec } from '../spec'

export const cSharp: LanguageSpec = {
  filetype: 'c_sharp',
  aliases: ['csharp', 'cs', 'c#'],
  call: 'function.call',
  operators: '+-*/%<>=!&|^~?',
  number:
    /(?:0[xX][0-9A-Fa-f_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)(?:[uU][lL]?|[lL][uU]?|[fFdDmM])?/,
  rules: [
    ...slashComments(),
    preprocessor(),
    quoted({ open: '$$"""', close: '"""', escape: null, multiline: true }),
    quoted({ open: '$"""', close: '"""', escape: null, multiline: true }),
    tripleQuoted(),
    quoted({ open: '$@"', close: '"', escape: null, doubled: true, multiline: true }),
    quoted({ open: '@$"', close: '"', escape: null, doubled: true, multiline: true }),
    quoted({ open: '@"', close: '"', escape: null, doubled: true, multiline: true }),
    quoted({ open: '$"', close: '"' }),
    doubleQuoted(),
    quoted({ open: "'", group: 'character' }),
    pattern({ match: /@[A-Za-z_][A-Za-z0-9_]*/, group: 'variable' }),
    pattern({
      match: /\[(?:[a-z]+\s*:\s*)?[A-Z][A-Za-z0-9_.]*[^\]\n]*\]/,
      group: 'attribute',
      atLineStart: true,
    }),
    pattern({ match: /[A-Z][A-Za-z0-9_]*(?=\s*\()/, group: 'function.call' }),
    typeByCase(),
  ],
  words: {
    keyword: [
      'as', 'await', 'break', 'case', 'catch', 'checked', 'class', 'continue', 'default',
      'delegate', 'do', 'else', 'enum', 'event', 'explicit', 'finally', 'fixed', 'for', 'foreach',
      'get', 'goto', 'if', 'implicit', 'in', 'init', 'interface', 'internal', 'is', 'lock',
      'nameof', 'namespace', 'new', 'operator', 'out', 'params', 'private', 'protected', 'public',
      'record', 'ref', 'return', 'set', 'sizeof', 'stackalloc', 'struct', 'switch', 'throw',
      'try', 'typeof', 'unchecked', 'using', 'var', 'when', 'where', 'while', 'with', 'yield',
    ],
    storageclass: [
      'abstract', 'async', 'extern', 'override', 'partial', 'sealed', 'static', 'unsafe',
      'virtual',
    ],
    'type.qualifier': ['const', 'readonly', 'volatile'],
    'type.builtin': [
      'bool', 'byte', 'char', 'decimal', 'double', 'dynamic', 'float', 'int', 'long', 'nint',
      'nuint', 'object', 'sbyte', 'short', 'string', 'uint', 'ulong', 'ushort', 'void',
    ],
    'constant.builtin': ['true', 'false', 'null'],
    'variable.builtin': ['this', 'base'],
  },
}
