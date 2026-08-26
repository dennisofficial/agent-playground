import { blockComment, lineComment, pattern, singleQuoted } from '../rules'
import type { LanguageSpec } from '../spec'

export const pascal: LanguageSpec = {
  filetype: 'pascal',
  aliases: ['pas'],
  caseInsensitive: true,
  call: 'function.call',
  operators: '+-*/=<>@^',
  rules: [
    pattern({ match: /\{\$[^}]*\}/, group: 'keyword.directive' }),
    blockComment({ open: '{', close: '}' }),
    blockComment({ open: '(*', close: '*)' }),
    lineComment({ open: '//' }),
    singleQuoted({ escape: null, doubled: true }),
    pattern({ match: /:=/, group: 'operator' }),
    pattern({ match: /\$[0-9A-Fa-f]+/, group: 'number' }),
    pattern({ match: /%[01]+/, group: 'number' }),
    pattern({ match: /&[0-7]+/, group: 'number' }),
    pattern({ match: /#(?:\$[0-9A-Fa-f]+|\d+)/, group: 'character' }),
  ],
  words: {
    keyword: [
      'program', 'unit', 'library', 'interface', 'implementation', 'initialization', 'finalization',
      'uses', 'var', 'const', 'type', 'procedure', 'function', 'begin', 'end', 'if', 'then', 'else',
      'case', 'of', 'while', 'do', 'for', 'to', 'downto', 'repeat', 'until', 'with', 'record',
      'array', 'set', 'file', 'packed', 'label', 'goto', 'and', 'or', 'not', 'xor', 'div', 'mod',
      'shl', 'shr', 'in', 'is', 'as', 'forward', 'external', 'asm', 'class', 'object', 'constructor',
      'destructor', 'inherited', 'property', 'private', 'protected', 'public', 'published',
      'virtual', 'override', 'overload', 'try', 'except', 'finally', 'raise', 'out', 'exports',
    ],
    type: [
      'integer', 'real', 'boolean', 'char', 'string', 'byte', 'word', 'longint', 'cardinal',
      'double', 'extended', 'pointer', 'shortint', 'smallint', 'int64', 'qword', 'single',
      'currency', 'ansistring', 'widestring', 'variant',
    ],
    'constant.builtin': ['true', 'false', 'nil'],
    'function.builtin': [
      'write', 'writeln', 'read', 'readln', 'new', 'dispose', 'length', 'setlength', 'inc', 'dec',
      'exit', 'halt', 'sizeof', 'ord', 'chr', 'abs', 'sqr', 'sqrt', 'round', 'trunc', 'assert',
      'high', 'low', 'copy', 'pos', 'str', 'val', 'assign', 'close', 'reset', 'rewrite',
    ],
  },
}
