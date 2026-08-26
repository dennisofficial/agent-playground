import { doubleQuoted, pattern, semicolonComment } from '../rules'
import { ELexRule, type LanguageSpec, type SpanRule } from '../spec'

const nestingBracedString: SpanRule = {
  kind: ELexRule.span,
  open: '{',
  close: '}',
  nests: true,
  group: 'string',
}

export const rebol: LanguageSpec = {
  filetype: 'rebol',
  aliases: ['red'],
  caseInsensitive: true,
  identifier: /[A-Za-z_][A-Za-z0-9_?!*-]*/,
  operators: '+-*/<>=',
  rules: [
    semicolonComment(),
    doubleQuoted({ escape: '^' }),
    nestingBracedString,
    pattern({ match: /[A-Za-z_][A-Za-z0-9_?!*-]*:/, group: 'variable' }),
    pattern({ match: /[A-Za-z][A-Za-z0-9_?*-]*!/, group: 'type' }),
  ],
  words: {
    keyword: [
      'func', 'function', 'does', 'has', 'if', 'either', 'unless', 'while', 'until', 'loop',
      'repeat', 'foreach', 'forall', 'forskip', 'return', 'exit', 'break', 'continue', 'switch',
      'case', 'any', 'all', 'use', 'context', 'object', 'make', 'bind', 'do', 'reduce', 'compose',
    ],
    'function.builtin': [
      'print', 'probe', 'append', 'insert', 'remove', 'copy', 'find', 'select', 'length?', 'type?',
      'form', 'mold', 'load', 'save', 'read', 'write', 'now',
    ],
    'constant.builtin': ['none', 'true', 'false', 'on', 'off', 'yes', 'no'],
  },
}
