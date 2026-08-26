import { pattern, quoted, typeByCase } from '../rules'
import type { LanguageSpec, LexRule } from '../spec'

const doubleQuotedComment: LexRule = quoted({
  open: '"',
  group: 'comment',
  escape: null,
  doubled: true,
  multiline: true,
})

const singleQuotedString: LexRule = quoted({
  open: "'",
  escape: null,
  doubled: true,
  multiline: true,
})

const quotedSymbol: LexRule = quoted({
  open: "#'",
  close: "'",
  group: 'string.special.symbol',
  escape: null,
  doubled: true,
})

const selectorSymbol: LexRule = pattern({
  match: /#[A-Za-z_][A-Za-z0-9_]*(?::[A-Za-z_][A-Za-z0-9_]*)*:?/,
  group: 'string.special.symbol',
})

const literalArrayOpener: LexRule = pattern({ match: /#[([]/, group: 'string.special.symbol' })

const binarySelectorSymbol: LexRule = pattern({
  match: /#[-+*\/\\~<>=&|@%,?!]+/,
  group: 'string.special.symbol',
})

const characterLiteral: LexRule = pattern({ match: /\$[\s\S]/, group: 'character' })

const assignment: LexRule = pattern({ match: /:=/, group: 'operator' })

const blockParameter: LexRule = pattern({
  match: /:[A-Za-z_][A-Za-z0-9_]*/,
  group: 'variable.parameter',
})

const keywordSelector: LexRule = pattern({
  match: /[A-Za-z_][A-Za-z0-9_]*:(?!=)/,
  group: 'function.method',
})

const returnCaret: LexRule = pattern({ match: /\^/, group: 'keyword.return' })

export const smalltalk: LanguageSpec = {
  filetype: 'smalltalk',
  aliases: ['st'],
  rules: [
    doubleQuotedComment,
    singleQuotedString,
    quotedSymbol,
    selectorSymbol,
    literalArrayOpener,
    binarySelectorSymbol,
    characterLiteral,
    assignment,
    blockParameter,
    keywordSelector,
    returnCaret,
    typeByCase(),
  ],
  number: /\d+r[0-9A-Za-z]+|\d[\d_]*(?:\.\d+)?(?:[eEsSdDqQ][+-]?\d*)?/,
  operators: '+-*/\\%<>=!&|^~,@',
  words: {
    'constant.builtin': ['self', 'super', 'thisContext', 'nil', 'true', 'false'],
    'function.builtin': [
      'new',
      'basicNew',
      'yourself',
      'value',
      'class',
      'printNl',
      'displayNl',
      'printString',
      'displayString',
      'isNil',
      'notNil',
    ],
  },
}
