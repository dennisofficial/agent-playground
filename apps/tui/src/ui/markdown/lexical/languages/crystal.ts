import { doubleQuoted, hashComment, pattern, sigilVariable, typeByCase } from '../rules'
import type { LanguageSpec } from '../spec'

export const crystal: LanguageSpec = {
  filetype: 'crystal',
  aliases: ['cr'],
  call: 'function.call',
  rules: [
    hashComment(),
    doubleQuoted(),
    pattern({ match: /@\[[^\]\n]*\]/, group: 'attribute' }),
    sigilVariable({ sigil: '@@', group: 'variable.member' }),
    sigilVariable({ sigil: '@', group: 'variable.member' }),
    pattern({
      match: /'(?:\\u\{[0-9A-Fa-f]+\}|\\u[0-9A-Fa-f]{4}|\\.|[^'\\\n])'/,
      group: 'character',
    }),
    pattern({ match: /::/, group: 'punctuation' }),
    pattern({ match: /:[A-Za-z_][A-Za-z0-9_]*[?!]?/, group: 'string.special.symbol' }),
    typeByCase(),
  ],
  identifier: /[a-z_][A-Za-z0-9_]*[?!]?/,
  number:
    /(?:0[xX][0-9A-Fa-f_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)(?:_?[iuf](?:8|16|32|64|128))?/,
  words: {
    keyword: [
      'abstract', 'alias', 'alignof', 'annotation', 'as', 'as?', 'asm', 'begin', 'break', 'case',
      'class', 'def', 'do', 'else', 'elsif', 'end', 'ensure', 'enum', 'extend', 'fun', 'getter',
      'getter!', 'getter?', 'if', 'in', 'include', 'instance_alignof', 'instance_sizeof', 'is_a?',
      'lib', 'macro', 'module', 'next', 'of', 'offsetof', 'out', 'pointerof', 'private',
      'property', 'property!', 'property?', 'protected', 'require', 'rescue', 'responds_to?',
      'return', 'select', 'setter', 'sizeof', 'spawn', 'struct', 'super', 'then', 'typeof',
      'uninitialized', 'union', 'unless', 'until', 'verbatim', 'when', 'while', 'with', 'yield',
    ],
    'constant.builtin': ['nil', 'true', 'false', 'self'],
    'function.builtin': ['puts', 'print', 'p', 'p!', 'pp', 'pp!', 'raise', 'loop', 'new'],
  },
}
