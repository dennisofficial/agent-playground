import { doubleQuoted, pattern, sigilVariable, singleQuoted, slashComments } from '../rules'
import type { LanguageSpec } from '../spec'

export const scss: LanguageSpec = {
  filetype: 'scss',
  aliases: [],
  call: 'function.call',
  rules: [
    pattern({ match: /(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|(?<=\()\/\/)[^\s"')]*/, group: 'string' }),
    ...slashComments(),
    doubleQuoted(),
    singleQuoted(),
    sigilVariable({
      sigil: '$',
      word: '-?[A-Za-z_][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)*',
      group: 'variable',
    }),
    pattern({ match: /#\{/, group: 'punctuation.special' }),
    pattern({
      match: /#(?:[0-9A-Fa-f]{8}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{3})(?![0-9A-Za-z])/,
      group: 'constant',
    }),
    pattern({ match: /#-?[A-Za-z_][A-Za-z0-9_-]*/, group: 'type' }),
    pattern({ match: /%-?[A-Za-z_][A-Za-z0-9_-]*/, group: 'type' }),
    pattern({ match: /@[a-z][a-z-]*/, group: 'keyword.directive' }),
    pattern({ match: /![a-z]+/, group: 'keyword' }),
    pattern({ match: /::?-{0,2}[A-Za-z][A-Za-z0-9-]*/, group: 'attribute' }),
    pattern({ match: /-{0,2}[a-z][a-z0-9-]*(?=\s*:(?![A-Za-z:]))/, group: 'property' }),
    pattern({ match: /(?<![\w)])\.-?[A-Za-z_][A-Za-z0-9_-]*/, group: 'type' }),
    pattern({
      match: /(?<=(?:^|[,>+~{}])[ \t]*)[a-z][a-z0-9]*(?=\s*(?:[{,>+~[]|::|:[a-z]))/m,
      group: 'tag',
    }),
    pattern({ match: /&/, group: 'operator' }),
  ],
  identifier: /-{0,2}[A-Za-z_][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)*/,
  number: /\d+(?:\.\d+)?(?:%|[a-z]+)?/,
  words: {
    keyword: ['and', 'as', 'from', 'if', 'in', 'not', 'or', 'through', 'to'],
    'constant.builtin': [
      'true', 'false', 'null', 'none', 'inherit', 'initial', 'unset', 'auto', 'currentColor',
      'transparent',
    ],
  },
}
