import { doubleQuoted, pattern, singleQuoted, slashComments } from '../rules'
import type { LanguageSpec } from '../spec'

export const less: LanguageSpec = {
  filetype: 'less',
  aliases: [],
  call: 'function.call',
  rules: [
    pattern({
      match: /(?<=(?:^|[^A-Za-z0-9_-])url\(\s*)[^)'"\n]+/,
      group: 'string',
    }),
    ...slashComments(),
    doubleQuoted(),
    singleQuoted(),
    pattern({ match: /~(?:"[^"\n]*"|'[^'\n]*')/, group: 'string.escape' }),
    pattern({
      match:
        /@(?:font-face|namespace|container|keyframes|arguments|supports|document|viewport|charset|import|media|layer|plugin|page|rest)(?![A-Za-z0-9_-])/,
      group: 'keyword.directive',
    }),
    pattern({ match: /@@[A-Za-z_-][A-Za-z0-9_-]*/, group: 'variable' }),
    pattern({ match: /@\{[A-Za-z_-][A-Za-z0-9_-]*\}/, group: 'variable' }),
    pattern({ match: /@[A-Za-z_-][A-Za-z0-9_-]*/, group: 'variable' }),
    pattern({
      match: /#(?:[0-9A-Fa-f]{8}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{3,4})(?![A-Za-z0-9_-])/,
      group: 'constant',
    }),
    pattern({ match: /#[A-Za-z_-][A-Za-z0-9_-]*/, group: 'type' }),
    pattern({
      match: /[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:%|[a-z]{1,5}(?![A-Za-z0-9_-]))?/,
      group: 'number',
    }),
    pattern({ match: /\.[A-Za-z_-][A-Za-z0-9_-]*/, group: 'type' }),
    pattern({
      match:
        /::?(?:placeholder-shown|nth-last-child|focus-visible|focus-within|first-letter|first-of-type|only-of-type|last-of-type|nth-of-type|first-child|only-child|last-child|placeholder|first-line|nth-child|selection|backdrop|disabled|required|optional|invalid|visited|checked|enabled|active|before|target|marker|extend|empty|valid|focus|hover|after|where|link|root|has|not|is)(?![A-Za-z0-9_-])/,
      group: 'attribute',
    }),
    pattern({ match: /!(?:important|default)(?![A-Za-z0-9_-])/, group: 'keyword' }),
    pattern({
      match:
        /(?:blockquote|figcaption|textarea|fieldset|picture|caption|details|section|summary|article|address|iframe|footer|header|button|dialog|legend|option|select|strong|figure|canvas|aside|input|label|small|table|tbody|tfoot|thead|video|abbr|body|code|form|html|main|span|time|img|nav|pre|sub|sup|svg|br|dd|dl|dt|em|h1|h2|h3|h4|h5|h6|hr|li|ol|td|th|tr|ul|a|b|i|p|u)(?![A-Za-z0-9_-])/,
      group: 'tag',
    }),
    pattern({ match: /[A-Za-z-][A-Za-z0-9_-]*(?=[ \t]*:(?!:))/, group: 'property' }),
  ],
  identifier: /[A-Za-z_-][A-Za-z0-9_-]*/,
  operators: '+*/<>~=&|',
  words: {
    keyword: ['when', 'and', 'not', 'or', 'from', 'to'],
    'constant.builtin': [
      'true',
      'false',
      'none',
      'inherit',
      'initial',
      'unset',
      'auto',
      'transparent',
    ],
  },
}
