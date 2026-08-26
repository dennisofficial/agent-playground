import { doubleQuoted, hashComment, pattern, quoted, singleQuoted } from '../rules'
import type { LanguageSpec } from '../spec'

export const r: LanguageSpec = {
  filetype: 'r',
  aliases: ['rscript'],
  call: 'function.call',
  rules: [
    hashComment(),
    doubleQuoted(),
    singleQuoted(),
    quoted({ open: '`', escape: null, group: 'variable' }),
    pattern({ match: /%[^%\s]*%/, group: 'operator' }),
    pattern({ match: /\.\d+(?:[eE][+-]?\d+)?[Li]?/, group: 'number' }),
  ],
  identifier: /[A-Za-z._][A-Za-z0-9._]*/,
  number: /(?:0[xX][0-9A-Fa-f]+[Li]?|\d+\.?\d*(?:[eE][+-]?\d+)?[Li]?)/,
  operators: '+-*/%<>=!&|^~:$@',
  words: {
    keyword: [
      'function', 'if', 'else', 'for', 'while', 'repeat', 'break', 'next', 'return', 'in',
    ],
    'constant.builtin': [
      'TRUE', 'FALSE', 'NULL', 'NA', 'NaN', 'Inf', 'T', 'F',
      'NA_integer_', 'NA_real_', 'NA_character_',
    ],
    'function.builtin': [
      'library', 'require', 'c', 'list', 'vector', 'print', 'paste', 'paste0', 'cat', 'sprintf',
      'length', 'nrow', 'ncol', 'apply', 'sapply', 'lapply', 'data.frame', 'matrix', 'factor',
    ],
  },
}
