import {
  annotation,
  blockComment,
  doubleQuoted,
  lineComment,
  pattern,
  tripleQuoted,
  typeByCase,
} from '../rules'
import type { LanguageSpec } from '../spec'

const interpolatedTripleQuoted = pattern({ match: /(?:raw|[a-z])"""[\s\S]*?"""/, group: 'string' })
const interpolatedString = pattern({ match: /(?:raw|[a-z])"(?:\\.|[^"\\\n])*"/, group: 'string' })
const charLiteral = pattern({ match: /'(?:\\.|[^'\\\n])'/, group: 'character' })
const noneAndNil = pattern({ match: /(?:None|Nil)(?![A-Za-z0-9_])/, group: 'constant.builtin' })

const numberWithTypeSuffix =
  /(?:0[xX][0-9A-Fa-f_]+[lL]?|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?[fFdDlL]?)/

export const scala: LanguageSpec = {
  filetype: 'scala',
  aliases: ['sc', 'sbt'],
  call: 'function.call',
  number: numberWithTypeSuffix,
  rules: [
    lineComment({ open: '//' }),
    blockComment({ open: '/*', close: '*/', nests: true }),
    interpolatedTripleQuoted,
    tripleQuoted(),
    interpolatedString,
    doubleQuoted(),
    charLiteral,
    annotation(),
    noneAndNil,
    typeByCase(),
  ],
  words: {
    keyword: [
      'abstract', 'case', 'catch', 'class', 'def', 'do', 'else', 'enum', 'export', 'extends',
      'extension', 'final', 'finally', 'for', 'forSome', 'given', 'if', 'implicit', 'import',
      'inline', 'lazy', 'macro', 'match', 'new', 'object', 'override', 'package', 'private',
      'protected', 'return', 'sealed', 'super', 'then', 'this', 'throw', 'trait', 'try', 'type',
      'using', 'val', 'var', 'while', 'with', 'yield',
    ],
    'constant.builtin': ['null', 'true', 'false'],
    'function.builtin': ['println', 'print', 'printf'],
  },
}
