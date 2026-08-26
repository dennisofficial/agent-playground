import { dashComment, pattern, quoted } from '../rules'
import type { LanguageSpec } from '../spec'

export const ada: LanguageSpec = {
  filetype: 'ada',
  aliases: ['adb', 'ads'],
  caseInsensitive: true,
  call: 'function.call',
  rules: [
    dashComment(),
    quoted({ open: '"', escape: null, doubled: true }),
    pattern({ match: /'(?:[A-Za-z_][A-Za-z0-9_]+|[A-Za-z_](?!'))/, group: 'attribute' }),
    pattern({ match: /'[^\n]'/, group: 'character' }),
    pattern({ match: /\d[\d_]*#[0-9A-Fa-f_]+(?:\.[0-9A-Fa-f_]+)?#(?:[eE][+-]?\d+)?/, group: 'number' }),
    pattern({ match: /:=/, group: 'operator' }),
    pattern({ match: /\.\./, group: 'operator' }),
  ],
  words: {
    keyword: [
      'abort', 'abs', 'abstract', 'accept', 'access', 'aliased', 'all', 'and', 'array', 'at',
      'begin', 'body', 'case', 'constant', 'declare', 'delay', 'delta', 'digits', 'do', 'else',
      'elsif', 'end', 'entry', 'exception', 'exit', 'for', 'function', 'generic', 'goto', 'if',
      'in', 'interface', 'is', 'limited', 'loop', 'mod', 'new', 'not', 'of', 'or', 'others', 'out',
      'overriding', 'package', 'pragma', 'private', 'procedure', 'protected', 'raise', 'range',
      'record', 'rem', 'renames', 'requeue', 'return', 'reverse', 'select', 'separate', 'some',
      'subtype', 'synchronized', 'tagged', 'task', 'terminate', 'then', 'type', 'use', 'when',
      'while', 'with', 'xor',
    ],
    type: [
      'integer', 'float', 'boolean', 'character', 'string', 'natural', 'positive', 'duration',
      'wide_string',
    ],
    'constant.builtin': ['true', 'false', 'null'],
  },
}
