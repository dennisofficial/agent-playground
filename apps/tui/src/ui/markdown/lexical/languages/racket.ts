import { blockComment, doubleQuoted, lineComment, pattern, semicolonComment } from '../rules'
import type { LanguageSpec } from '../spec'

export const racket: LanguageSpec = {
  filetype: 'racket',
  aliases: ['rkt'],
  rules: [
    blockComment({ open: '#|', close: '|#', nests: true }),
    lineComment({ open: '#;' }),
    semicolonComment(),
    doubleQuoted(),
    pattern({ match: /#lang[ \t]+[^\s()[\]{}]+/, group: 'keyword.directive', atLineStart: true }),
    pattern({ match: /#(?:true|false|[tf])(?![A-Za-z0-9_])/, group: 'constant.builtin' }),
    pattern({ match: /#:[A-Za-z][A-Za-z0-9_+\-*\/<>=!?]*/, group: 'attribute' }),
    pattern({ match: /#[eibodx]#?[0-9A-Fa-f]+(?:[.\/][0-9A-Fa-f]+)?/, group: 'number' }),
    pattern({ match: /#\\(?:[A-Za-z]+|.)/, group: 'character' }),
    pattern({ match: /#(?:hash(?:eqv?)?|s)?(?=[([])/, group: 'punctuation' }),
    pattern({
      match: /[+-]?(?:(?:inf|nan)\.0|\d+(?:\/\d+|\.\d*)?(?:[eE][+-]?\d+)?|\.\d+)/,
      group: 'number',
    }),
    pattern({ match: /λ(?![A-Za-z0-9_+\-*\/<>=!?])/, group: 'keyword' }),
    pattern({ match: /'[A-Za-z_][A-Za-z0-9_+\-*\/<>=!?]*/, group: 'string.special.symbol' }),
  ],
  identifier: /[A-Za-z_+\-*\/<>=!?][A-Za-z0-9_+\-*\/<>=!?]*/,
  operators: '',
  words: {
    keyword: [
      'define', 'define-values', 'define-syntax', 'define-syntax-rule', 'define-struct',
      'define/contract', 'struct', 'lambda', 'let', 'let*', 'letrec', 'let-values', 'if', 'cond',
      'case', 'match', 'match-define', 'else', 'and', 'or', 'when', 'unless', 'begin', 'for',
      'for/list', 'for/fold', 'for*', 'do', 'set!', 'quote', 'quasiquote', 'require', 'provide',
      'module', 'module+', 'submodule', 'parameterize', 'with-handlers', 'contract-out',
      'all-defined-out',
    ],
    'constant.builtin': ['null', 'empty', 'eof'],
    'function.builtin': [
      'display', 'displayln', 'print', 'printf', 'format', 'error', 'list', 'cons', 'car', 'cdr',
      'append', 'reverse', 'length', 'map', 'filter', 'foldl', 'foldr', 'apply', 'hash', 'hash-ref',
      'vector-ref', 'in-range', 'string-append', 'number->string', 'string->number', 'add1', 'sub1',
      'not', 'number?', 'zero?', 'null?', 'equal?',
    ],
  },
}
