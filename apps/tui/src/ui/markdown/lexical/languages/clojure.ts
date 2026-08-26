import { doubleQuoted, pattern, quoted, semicolonComment } from '../rules'
import type { LanguageSpec } from '../spec'

const NUMERIC = String.raw`(?:0[xX][0-9A-Fa-f]+|\d+[rR][0-9A-Za-z]+|\d+\/\d+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[MN]?)`

export const clojure: LanguageSpec = {
  filetype: 'clojure',
  aliases: ['clj', 'cljc', 'cljs', 'edn'],
  rules: [
    semicolonComment(),
    quoted({ open: '#"', close: '"', group: 'string.regexp' }),
    doubleQuoted({ multiline: true }),
    pattern({
      match: /\\(?:newline|space|tab|return|formfeed|backspace|u[0-9A-Fa-f]{4}|o[0-7]{1,3}|\S)/,
      group: 'character',
    }),
    pattern({ match: new RegExp(`-${NUMERIC}`), group: 'number' }),
    pattern({ match: /::?[A-Za-z0-9*+!\-_<>=&%$?\/.]+/, group: 'string.special.symbol' }),
    pattern({ match: /[@'`~^#]+/, group: 'punctuation.special' }),
    pattern({ match: /[A-Z][A-Za-z0-9*+!\-_<>=?.]*/, group: 'type' }),
  ],
  identifier: /[A-Za-z*+!\-_<>=&%$?\/.][A-Za-z0-9*+!\-_<>=&%$?\/.']*/,
  number: new RegExp(NUMERIC),
  operators: '',
  words: {
    keyword: [
      'def', 'defn', 'defn-', 'defmacro', 'defmulti', 'defmethod', 'defonce', 'defprotocol',
      'defrecord', 'defstruct', 'deftype', 'declare', 'extend-type', 'extend-protocol', 'reify',
      'proxy', 'fn', 'let', 'letfn', 'binding', 'if', 'if-let', 'if-not', 'if-some', 'when',
      'when-let', 'when-not', 'when-some', 'cond', 'condp', 'case', 'do', 'doseq', 'dotimes',
      'while', 'for', 'loop', 'recur', 'and', 'or', 'ns', 'in-ns', 'require', 'use', 'import',
      'refer', 'try', 'catch', 'finally', 'throw', 'quote', 'var', 'set!', 'new', 'doto', 'as->',
      '->', '->>', 'some->', 'some->>', 'cond->', 'cond->>',
    ],
    'constant.builtin': ['nil', 'true', 'false'],
    'function.builtin': [
      'println', 'print', 'prn', 'pr', 'printf', 'format', 'str', 'name', 'symbol', 'keyword',
      'atom', 'deref', 'swap!', 'reset!', 'ref', 'agent', 'delay', 'force', 'ex-info', 'ex-data',
      'map', 'mapv', 'mapcat', 'filter', 'remove', 'reduce', 'reductions', 'apply', 'partial',
      'comp', 'juxt', 'identity', 'constantly', 'conj', 'cons', 'concat', 'into', 'assoc',
      'assoc-in', 'dissoc', 'update', 'update-in', 'get', 'get-in', 'merge', 'select-keys',
      'keys', 'vals', 'count', 'first', 'second', 'rest', 'next', 'last', 'nth', 'take', 'drop',
      'seq', 'vec', 'vector', 'list', 'hash-map', 'hash-set', 'set', 'sort', 'sort-by', 'group-by',
      'range', 'repeat', 'repeatedly', 'interpose', 'partition', 'reverse', 'inc', 'dec', 'min',
      'max', 'quot', 'rem', 'mod', 'even?', 'odd?', 'zero?', 'pos?', 'neg?', 'nil?', 'some?',
      'empty?', 'seq?', 'map?', 'vector?', 'coll?', 'string?', 'number?', 'contains?', 'not',
      'not=', '=', '==', '<', '>', '<=', '>=', '+', '-', '*', '/',
    ],
  },
}
