import { blockComment, doubleQuoted, hashComment, pattern, tripleQuoted } from '../rules'
import type { LanguageSpec } from '../spec'

const rawString = /[A-Za-z_][A-Za-z0-9_]*"(?:[^"\n]|"")*"/
const charLiteral = /'(?:\\(?:[abceflnprtv\\'"0]|x[0-9A-Fa-f]{2}|\d{1,3})|[^\\'\n])'/
const pragma = /\{\..*?\.\}/

export const nim: LanguageSpec = {
  filetype: 'nim',
  aliases: ['nims'],
  call: 'function.call',
  rules: [
    blockComment({ open: '##[', close: ']##', nests: true }),
    blockComment({ open: '#[', close: ']#', nests: true }),
    hashComment(),
    tripleQuoted(),
    doubleQuoted(),
    pattern({ match: rawString, group: 'string' }),
    pattern({ match: charLiteral, group: 'character' }),
    pattern({ match: pragma, group: 'attribute' }),
  ],
  words: {
    keyword: [
      'proc', 'func', 'method', 'iterator', 'converter', 'template', 'macro', 'type', 'object',
      'enum', 'tuple', 'ref', 'ptr', 'var', 'let', 'const', 'if', 'elif', 'else', 'case', 'of',
      'when', 'while', 'for', 'in', 'notin', 'is', 'isnot', 'block', 'break', 'continue', 'return',
      'yield', 'discard', 'import', 'export', 'include', 'from', 'as', 'try', 'except', 'finally',
      'raise', 'defer', 'static', 'mixin', 'bind', 'and', 'or', 'not', 'xor', 'div', 'mod', 'shl',
      'shr', 'cast', 'sizeof', 'addr', 'asm', 'using', 'do', 'end', 'concept', 'distinct', 'out',
    ],
    type: [
      'int', 'int32', 'int64', 'float', 'float64', 'string', 'bool', 'char', 'seq', 'array',
      'openArray', 'cstring', 'pointer', 'void',
    ],
    'constant.builtin': ['true', 'false', 'nil', 'result'],
    'function.builtin': ['echo', 'new', 'len', 'add', 'high', 'low', 'inc', 'dec', 'newSeq', 'quit'],
  },
}
