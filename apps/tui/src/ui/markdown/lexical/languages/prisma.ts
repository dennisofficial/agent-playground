import { doubleQuoted, lineComment, pattern, typeByCase } from '../rules'
import type { LanguageSpec } from '../spec'

const BLOCK_KEYWORDS = 'datasource|generator|model|enum|type|view'

export const prisma: LanguageSpec = {
  filetype: 'prisma',
  call: 'function.call',
  rules: [
    lineComment({ open: '//' }),
    doubleQuoted(),
    pattern({ match: /@@?[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?/, group: 'attribute' }),
    pattern({
      match: /(?:String|Boolean|Int|BigInt|Float|Decimal|DateTime|Json|Bytes|Unsupported)\b/,
      group: 'type.builtin',
    }),
    pattern({ match: /(?<=\b(?:datasource|generator)[ \t]+)[a-z_][A-Za-z0-9_]*/, group: 'type' }),
    pattern({ match: /[A-Z][A-Z0-9_]*\b/, group: 'constant', atLineStart: true }),
    pattern({
      match: new RegExp(`(?!(?:${BLOCK_KEYWORDS})\\b)[a-z_][A-Za-z0-9_]*`),
      group: 'property',
      atLineStart: true,
    }),
    pattern({ match: /[a-z_][A-Za-z0-9_]*(?=[ \t]*:)/, group: 'property' }),
    pattern({ match: /(?<=[[,][ \t]*)[a-z_][A-Za-z0-9_]*/, group: 'property' }),
    typeByCase(),
    pattern({ match: /\?|\[\]/, group: 'punctuation' }),
  ],
  words: {
    keyword: ['datasource', 'generator', 'model', 'enum', 'type', 'view'],
    'constant.builtin': ['true', 'false', 'null'],
  },
}
