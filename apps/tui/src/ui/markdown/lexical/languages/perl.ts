import { doubleQuoted, hashComment, pattern, sigilVariable, singleQuoted } from '../rules'
import type { LanguageSpec } from '../spec'

const NAME = '[A-Za-z_][A-Za-z0-9_]*'
const QUALIFIED = `${NAME}(?:::${NAME})*`
const SIGIL_TARGET = `\\$*${QUALIFIED}`

const pod = pattern({
  match: /=(?:pod|head[1-4]|over|item|back|begin|end|for|encoding)\b[\s\S]*?(?:\n=cut[^\n]*|$)/,
  group: 'comment',
  atLineStart: true,
})

const quoteForm = pattern({
  match: /q[qwr]?\s*(?:\([^)]*\)|\{[^}]*\}|\[[^\]]*\]|<[^>\n]*>|\/[^/\n]*\/)/,
  group: 'string',
})

const punctuationVariable = pattern({ match: /\$(?:\d+|[!@?&$|,;])/, group: 'variable' })

const declaredPackage = pattern({
  match: new RegExp(`(?<=\\bpackage\\s+)${QUALIFIED}`),
  group: 'module',
})

const importedPackage = pattern({
  match: new RegExp(`(?<=\\b(?:use|no|require)\\s+)${QUALIFIED}`),
  group: 'module',
})

const declaredSub = pattern({ match: new RegExp(`(?<=\\bsub\\s+)${NAME}`), group: 'function' })

const invokedClass = pattern({
  match: new RegExp(`(?<!->)(?![A-Z_]+->)${QUALIFIED}(?=->)`),
  group: 'type',
})

const referencedPackage = pattern({ match: new RegExp(`${NAME}(?:::${NAME})+`), group: 'module' })

export const perl: LanguageSpec = {
  filetype: 'perl',
  aliases: ['perl5'],
  call: 'function.call',
  rules: [
    pod,
    hashComment(),
    doubleQuoted(),
    singleQuoted(),
    quoteForm,
    sigilVariable({ sigil: '$#', word: SIGIL_TARGET }),
    sigilVariable({ sigil: '$', word: SIGIL_TARGET }),
    sigilVariable({ sigil: '@', word: SIGIL_TARGET }),
    sigilVariable({ sigil: '%', word: SIGIL_TARGET }),
    punctuationVariable,
    declaredPackage,
    importedPackage,
    declaredSub,
    invokedClass,
    referencedPackage,
  ],
  words: {
    keyword: [
      'my', 'our', 'local', 'state', 'sub', 'package', 'use', 'no', 'require', 'return', 'if',
      'elsif', 'else', 'unless', 'while', 'until', 'for', 'foreach', 'do', 'last', 'next', 'redo',
      'goto', 'eval', 'and', 'or', 'not', 'xor', 'continue', 'BEGIN', 'END',
    ],
    'function.builtin': [
      'bless', 'ref', 'defined', 'wantarray', 'die', 'warn', 'print', 'printf', 'sprintf', 'push',
      'pop', 'shift', 'unshift', 'splice', 'keys', 'values', 'each', 'exists', 'delete', 'scalar',
      'sort', 'map', 'grep', 'join', 'split', 'reverse', 'chomp', 'length', 'open', 'close',
    ],
    'constant.builtin': ['undef', '__PACKAGE__', '__FILE__', '__LINE__', 'STDIN', 'STDOUT', 'STDERR'],
  },
}
