import { doubleQuoted, pattern, sigilVariable, singleQuoted, slashComments } from '../rules'
import type { LanguageSpec } from '../spec'

const SELECTOR_NAME = '[A-Za-z_-][A-Za-z0-9_-]*'

const WORD = '[A-Za-z_][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)*'

const DIRECTIVES = [
  'mixin', 'include', 'extend', 'use', 'forward', 'import', 'function', 'return', 'if', 'else',
  'each', 'for', 'while', 'media', 'supports', 'container', 'layer', 'at-root', 'content',
  'keyframes', 'font-face', 'charset', 'namespace', 'page', 'property', 'debug', 'warn', 'error',
]

const atRule = pattern({
  match: new RegExp(`@(?:${DIRECTIVES.join('|')})\\b`),
  group: 'keyword.directive',
})

const valueFlag = pattern({ match: /!(?:default|important|global|optional)\b/, group: 'keyword' })

const mixinDefinition = pattern({
  match: new RegExp(`=${SELECTOR_NAME}`),
  group: 'function',
  atLineStart: true,
})

const mixinInclude = pattern({
  match: new RegExp(`\\+${SELECTOR_NAME}`),
  group: 'function',
  atLineStart: true,
})

const urlValue = pattern({ match: /(?<=\burl\([ \t]*)[^)'"\n$#]+/, group: 'string' })

const hexColour = pattern({
  match: /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/,
  group: 'constant',
})

const idSelector = pattern({ match: new RegExp(`#${SELECTOR_NAME}`), group: 'type' })

const classSelector = pattern({
  match: new RegExp(`\\.${SELECTOR_NAME}(?![A-Za-z0-9_(-])`),
  group: 'type',
})

const fractionalLength = pattern({ match: /\.\d[\d_]*(?:%|[A-Za-z]+)?/, group: 'number' })

const pseudoSelector = pattern({ match: /::?-?[a-z][a-z0-9-]*/, group: 'attribute' })

const propertyName = pattern({
  match: /-?[a-z][a-z0-9-]*(?=[ \t]*:(?![A-Za-z:]))/,
  group: 'property',
})

const elementSelector = pattern({ match: /[a-z][a-z0-9-]*/, group: 'tag', atLineStart: true })

export const sass: LanguageSpec = {
  filetype: 'sass',
  aliases: [],
  call: 'function.call',
  rules: [
    ...slashComments(),
    doubleQuoted(),
    singleQuoted(),
    urlValue,
    sigilVariable({ sigil: '$', word: `-?${WORD}` }),
    atRule,
    valueFlag,
    mixinDefinition,
    mixinInclude,
    hexColour,
    idSelector,
    classSelector,
    fractionalLength,
    pseudoSelector,
    propertyName,
    elementSelector,
  ],
  identifier: new RegExp(WORD),
  number: /\d[\d_]*(?:\.\d+)?(?:%|[A-Za-z]+)?/,
  words: {
    keyword: ['and', 'or', 'not', 'from', 'through', 'in'],
    'constant.builtin': [
      'true', 'false', 'null', 'none', 'inherit', 'initial', 'auto', 'transparent',
    ],
  },
}
