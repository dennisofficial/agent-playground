import { blockComment, pattern, quoted } from '../rules'
import type { LanguageSpec } from '../spec'

const NAME = String.raw`[\p{L}_][\p{L}\p{N}_.:-]*`
const MARKUP_DECLARATION = /<!(?:DOCTYPE|ELEMENT|ENTITY|ATTLIST|NOTATION)\b/
const CHARACTER_DATA_HAS_NO_NUMBERS = /(?!)/

export const xml: LanguageSpec = {
  filetype: 'xml',
  aliases: ['xsd', 'xsl', 'xslt', 'svg', 'rss', 'plist', 'wsdl'],
  rules: [
    quoted({ open: '<![CDATA[', close: ']]>', escape: null, multiline: true }),
    blockComment({ open: '<!--', close: '-->' }),
    pattern({ match: MARKUP_DECLARATION, group: 'keyword.directive' }),
    pattern({ match: new RegExp(String.raw`<\?${NAME}`, 'u'), group: 'keyword.directive' }),
    pattern({ match: /\?>/, group: 'keyword.directive' }),
    pattern({ match: new RegExp(String.raw`</?${NAME}`, 'u'), group: 'tag' }),
    pattern({ match: new RegExp(String.raw`${NAME}(?=\s*=\s*["'])`, 'u'), group: 'attribute' }),
    pattern({ match: /(?<==\s*)"[^"]*"/, group: 'string' }),
    pattern({ match: /(?<==\s*)'[^']*'/, group: 'string' }),
    pattern({
      match: /&(?:#\d+|#[xX][0-9A-Fa-f]+|[\p{L}_][\p{L}\p{N}_.-]*);/u,
      group: 'string.escape',
    }),
  ],
  number: CHARACTER_DATA_HAS_NO_NUMBERS,
  operators: '',
}
