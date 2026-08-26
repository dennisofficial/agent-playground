import {
  doubleQuoted,
  hashComment,
  pattern,
  sigilVariable,
  singleQuoted,
} from '../rules'
import type { LanguageSpec } from '../spec'

export const ruby: LanguageSpec = {
  filetype: 'ruby',
  aliases: ['rb'],
  call: 'function.call',
  rules: [
    hashComment(),
    doubleQuoted(),
    singleQuoted(),
    sigilVariable({ sigil: '@@', group: 'variable.member' }),
    sigilVariable({ sigil: '@', group: 'variable.member' }),
    sigilVariable({ sigil: '$', group: 'variable' }),
    pattern({ match: /:[A-Za-z_][A-Za-z0-9_]*[?!]?/, group: 'string.special.symbol' }),
    pattern({ match: /[A-Z][A-Za-z0-9_]*/, group: 'type' }),
  ],
  identifier: /[a-z_][A-Za-z0-9_]*[?!]?/,
  words: {
    keyword: [
      'alias', 'and', 'begin', 'break', 'case', 'class', 'def', 'defined?', 'do', 'else', 'elsif',
      'end', 'ensure', 'for', 'if', 'in', 'module', 'next', 'not', 'or', 'redo', 'rescue', 'retry',
      'return', 'then', 'undef', 'unless', 'until', 'when', 'while', 'yield', 'lambda', 'proc',
      'require', 'require_relative', 'include', 'extend', 'attr_accessor', 'attr_reader',
      'attr_writer', 'private', 'protected', 'public', 'raise', 'super',
    ],
    'constant.builtin': ['true', 'false', 'nil', 'self', '__method__'],
    'function.builtin': ['puts', 'print', 'p', 'gets', 'loop', 'new'],
  },
}
