import {
  blockComment,
  doubleQuoted,
  pattern,
  percentComment,
  singleQuoted,
  variableByCase,
} from '../rules'
import type { LanguageSpec } from '../spec'

export const prolog: LanguageSpec = {
  filetype: 'prolog',
  aliases: ['pl', 'pro'],
  call: 'function.call',
  rules: [
    percentComment(),
    blockComment({ open: '/*', close: '*/' }),
    pattern({ match: /:-|\?-|-->/, group: 'keyword' }),
    pattern({ match: /!/, group: 'keyword' }),
    pattern({ match: /0'(?:\\.|.)/, group: 'character' }),
    pattern({ match: /\d+'[0-9A-Za-z]+/, group: 'number' }),
    doubleQuoted(),
    singleQuoted({ escape: null, doubled: true }),
    variableByCase(),
  ],
  identifier: /[a-z][A-Za-z0-9_]*/,
  operators: '+-*/\\<>=~^:;@|',
  words: {
    keyword: [
      'is', 'mod', 'rem', 'div', 'xor', 'rdiv', 'not',
      'dynamic', 'discontiguous', 'module', 'use_module', 'initialization',
    ],
    'constant.builtin': ['true', 'false', 'fail'],
    'function.builtin': [
      'assert', 'asserta', 'assertz', 'retract', 'findall', 'bagof', 'setof',
      'forall', 'between', 'nb_getval', 'format', 'write', 'writeln', 'nl',
    ],
  },
}
