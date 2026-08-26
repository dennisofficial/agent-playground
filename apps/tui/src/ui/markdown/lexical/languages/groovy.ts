import {
  doubleQuoted,
  lineComment,
  pattern,
  quoted,
  singleQuoted,
  slashComments,
  tripleQuoted,
  typeByCase,
} from '../rules'
import type { LanguageSpec } from '../spec'

export const groovy: LanguageSpec = {
  filetype: 'groovy',
  call: 'function.call',
  rules: [
    lineComment({ open: '#!', atLineStart: true }),
    ...slashComments(),
    tripleQuoted(),
    quoted({ open: "'''", escape: null, multiline: true }),
    doubleQuoted(),
    singleQuoted(),
    pattern({ match: /(?<!\.)@[A-Za-z_][A-Za-z0-9_]*/, group: 'attribute' }),
    typeByCase(),
  ],
  number: /(?:0[xXbB][0-9A-Fa-f_]+[LlGgIi]?|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?[LlGgDdFfIi]?)/,
  words: {
    keyword: [
      'abstract', 'as', 'assert', 'break', 'case', 'catch', 'class', 'continue', 'def', 'default',
      'do', 'else', 'enum', 'extends', 'final', 'finally', 'for', 'if', 'implements', 'import',
      'in', 'instanceof', 'interface', 'it', 'new', 'package', 'private', 'protected', 'public',
      'return', 'static', 'switch', 'synchronized', 'throw', 'throws', 'trait', 'transient', 'try',
      'var', 'volatile', 'while',
    ],
    'type.builtin': ['boolean', 'byte', 'char', 'double', 'float', 'int', 'long', 'short', 'void'],
    'constant.builtin': ['true', 'false', 'null'],
    'variable.builtin': ['this', 'super'],
    'function.builtin': ['println', 'print', 'printf', 'sprintf'],
  },
}
