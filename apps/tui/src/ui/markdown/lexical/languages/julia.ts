import { blockComment, doubleQuoted, hashComment, pattern, tripleQuoted, typeByCase } from '../rules'
import type { LanguageSpec } from '../spec'

const CHAR_LITERAL =
  /'(?:\\(?:x[0-9A-Fa-f]{1,2}|u[0-9A-Fa-f]{1,4}|U[0-9A-Fa-f]{1,8}|[0-7]{1,3}|.)|[\uD800-\uDBFF][\uDC00-\uDFFF]|[^'\\\n])'/

const NUMBER_LITERAL =
  /(?:0[xX][0-9A-Fa-f_]+(?:[pP][+-]?\d+)?|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eEf][+-]?\d+)?)/

export const julia: LanguageSpec = {
  filetype: 'julia',
  aliases: ['jl'],
  call: 'function.call',
  rules: [
    blockComment({ open: '#=', close: '=#', nests: true }),
    hashComment(),
    tripleQuoted(),
    doubleQuoted(),
    pattern({ match: CHAR_LITERAL, group: 'character' }),
    pattern({ match: /@(?:\.|[A-Za-z_][A-Za-z0-9_]*!?)/, group: 'function.macro' }),
    pattern({
      match: /(?<![A-Za-z0-9_)\]}]):[A-Za-z_][A-Za-z0-9_]*!*/,
      group: 'string.special.symbol',
    }),
    pattern({ match: /(?:Inf|NaN)(?:16|32|64)?(?![A-Za-z0-9_])/, group: 'constant.builtin' }),
    typeByCase(),
  ],
  identifier: /[A-Za-z_][A-Za-z0-9_]*(?:!(?!=))*/,
  number: NUMBER_LITERAL,
  operators: '+-*/%<>=!&|^~:\\?',
  words: {
    keyword: [
      'abstract', 'baremodule', 'begin', 'break', 'catch', 'const', 'continue', 'do', 'else',
      'elseif', 'end', 'export', 'finally', 'for', 'function', 'global', 'if', 'import', 'in',
      'isa', 'let', 'local', 'macro', 'module', 'mutable', 'outer', 'primitive', 'quote', 'return',
      'struct', 'try', 'type', 'using', 'where', 'while',
    ],
    'constant.builtin': ['true', 'false', 'nothing', 'missing', 'undef', 'pi', 'im'],
    'function.builtin': [
      'println', 'print', 'error', 'throw', 'typeof', 'length', 'size', 'sum', 'map', 'filter',
      'reduce', 'collect', 'sort', 'sort!', 'push!', 'pop!', 'append!', 'get', 'join', 'min',
      'max', 'abs', 'sqrt', 'string', 'parse', 'include', 'zeros', 'ones',
    ],
  },
}
