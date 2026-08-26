import {
  annotation,
  doubleQuoted,
  hashComment,
  pattern,
  quoted,
  sigilVariable,
  typeByCase,
} from '../rules'
import type { LanguageSpec } from '../spec'

const blockDescription = quoted({ open: '"""', escape: '\\', multiline: true })

export const graphql: LanguageSpec = {
  filetype: 'graphql',
  aliases: ['gql'],
  call: 'function.call',
  rules: [
    hashComment(),
    blockDescription,
    doubleQuoted(),
    sigilVariable({ sigil: '$' }),
    annotation(),
    pattern({ match: /\.\.\./, group: 'punctuation' }),
    pattern({ match: /(?:Int|Float|String|Boolean|ID)\b/, group: 'type.builtin' }),
    typeByCase(),
    pattern({ match: /[a-z_][A-Za-z0-9_]*(?=[ \t]*:)/, group: 'property' }),
  ],
  words: {
    keyword: [
      'query', 'mutation', 'subscription', 'fragment', 'on', 'type', 'input', 'interface', 'union',
      'enum', 'scalar', 'schema', 'directive', 'extend', 'implements', 'repeatable',
    ],
    'constant.builtin': ['true', 'false', 'null'],
  },
}
