import {
  annotation,
  blockComment,
  doubleQuoted,
  lineComment,
  pattern,
  quoted,
  tripleQuoted,
  typeByCase,
} from '../rules'
import type { LanguageSpec } from '../spec'

export const kotlin: LanguageSpec = {
  filetype: 'kotlin',
  aliases: ['kt', 'kts'],
  call: 'function.call',
  operators: '+-*/%<>=!&|^~?',
  number:
    /(?:0[xX][0-9A-Fa-f_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)(?:[uU][lL]?|[lL]|[fF])?/,
  rules: [
    lineComment({ open: '//' }),
    blockComment({ open: '/*', close: '*/', nests: true }),
    tripleQuoted(),
    doubleQuoted(),
    quoted({ open: "'", group: 'character' }),
    annotation(),
    pattern({ match: /[A-Z][A-Z0-9_]+(?![A-Za-z0-9_])/, group: 'constant' }),
    typeByCase(),
  ],
  words: {
    keyword: [
      'abstract', 'actual', 'annotation', 'as', 'break', 'by', 'catch', 'class', 'companion',
      'const', 'constructor', 'continue', 'crossinline', 'data', 'do', 'else', 'enum', 'expect',
      'external', 'final', 'finally', 'for', 'fun', 'if', 'import', 'in', 'infix', 'init',
      'inline', 'inner', 'interface', 'internal', 'is', 'lateinit', 'noinline', 'object', 'open',
      'operator', 'out', 'override', 'package', 'private', 'protected', 'public', 'reified',
      'return', 'sealed', 'suspend', 'tailrec', 'throw', 'try', 'typealias', 'val', 'var',
      'vararg', 'when', 'where', 'while',
    ],
    'constant.builtin': ['null', 'true', 'false', 'this', 'super'],
    'variable.builtin': ['it', 'field'],
    'function.builtin': [
      'println', 'print', 'readLine', 'listOf', 'mutableListOf', 'mapOf', 'mutableMapOf', 'setOf',
      'arrayOf', 'require', 'check', 'error', 'let', 'run', 'apply', 'also', 'with',
    ],
  },
}
