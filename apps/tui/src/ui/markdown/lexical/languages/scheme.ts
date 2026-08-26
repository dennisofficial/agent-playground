import { blockComment, doubleQuoted, pattern, semicolonComment } from '../rules'
import type { LanguageSpec } from '../spec'

export const scheme: LanguageSpec = {
  filetype: 'scheme',
  aliases: ['scm', 'ss'],
  rules: [
    blockComment({ open: '#|', close: '|#', nests: true }),
    pattern({
      match: /#;[ \t]*(?:\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)|[^\s()[\]{};]*)/,
      group: 'comment',
    }),
    semicolonComment(),
    doubleQuoted(),
    pattern({ match: /#\\(?:[A-Za-z][A-Za-z0-9-]+|.)/, group: 'character' }),
    pattern({ match: /#(?:true|false|[tf])(?![A-Za-z0-9])/, group: 'constant.builtin' }),
    pattern({
      match: /#[eibodxEIBODX](?:#[eibodxEIBODX])?[+-]?(?:[0-9A-Fa-f]+(?:\/[0-9A-Fa-f]+|\.[0-9A-Fa-f]*)?|\.[0-9A-Fa-f]+)|[+-](?:inf|nan)\.0|[+-]?(?:\d+\/\d+|(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?)/,
      group: 'number',
    }),
  ],
  identifier: /[A-Za-z_!$%&*\/:<=>?^~+-][A-Za-z0-9_!$%&*\/:<=>?^~+.-]*/,
  operators: '',
  words: {
    keyword: [
      'define', 'define-syntax', 'define-record-type', 'define-values', 'define-library',
      'syntax-rules', 'let-syntax', 'letrec-syntax', 'lambda', 'named-lambda', 'case-lambda',
      'let', 'let*', 'letrec', 'letrec*', 'let-values', 'let*-values',
      'if', 'cond', 'case', 'else', '=>', 'and', 'or', 'when', 'unless', 'begin', 'do',
      'delay', 'delay-force', 'force', 'make-promise', 'set!',
      'quote', 'quasiquote', 'unquote', 'unquote-splicing',
      'parameterize', 'guard', 'assert', 'import', 'export', 'include', 'cond-expand',
    ],
    'function.builtin': [
      'display', 'newline', 'write', 'write-string', 'read', 'error', 'raise', 'exit',
      'cons', 'car', 'cdr', 'cadr', 'cddr', 'list', 'list-ref', 'list-tail', 'append',
      'length', 'reverse', 'map', 'for-each', 'apply', 'assoc', 'assq', 'member', 'memq',
      'not', 'eq?', 'eqv?', 'equal?', 'null?', 'pair?', 'list?', 'number?', 'string?',
      'symbol?', 'procedure?', 'boolean?', 'zero?', 'even?', 'odd?',
      'vector', 'make-vector', 'vector-ref', 'vector-set!', 'vector-length',
      'string-append', 'string-length', 'substring', 'string->number', 'number->string',
      'string->symbol', 'symbol->string', 'string->list', 'list->string',
      '+', '-', '*', '/', '=', '<', '>', '<=', '>=',
      'abs', 'min', 'max', 'expt', 'sqrt', 'floor', 'ceiling', 'truncate', 'round',
      'quotient', 'remainder', 'modulo', 'gcd', 'lcm',
      'values', 'call-with-values', 'call/cc', 'call-with-current-continuation',
      'dynamic-wind', 'with-exception-handler', 'eval',
    ],
  },
}
