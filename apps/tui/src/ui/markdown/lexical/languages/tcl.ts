import { doubleQuoted, lineComment, pattern, sigilVariable } from '../rules'
import type { LanguageSpec } from '../spec'

const QUALIFIED_NAME = '(?:::)?[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*'

export const tcl: LanguageSpec = {
  filetype: 'tcl',
  aliases: ['tk'],
  rules: [
    lineComment({ open: '#', atLineStart: true }),
    doubleQuoted({ multiline: true }),
    pattern({ match: /\$\{[^}\n]*\}/, group: 'variable' }),
    sigilVariable({ sigil: '$', word: QUALIFIED_NAME }),
  ],
  words: {
    keyword: [
      'proc', 'set', 'unset', 'if', 'else', 'elseif', 'while', 'for', 'foreach', 'switch',
      'return', 'break', 'continue', 'expr', 'global', 'upvar', 'uplevel', 'variable',
      'namespace', 'package', 'source', 'eval', 'after', 'error', 'incr',
    ],
    'function.builtin': [
      'puts', 'lindex', 'llength', 'lappend', 'lrange', 'lsort', 'string', 'list', 'array',
      'dict', 'format', 'scan', 'open', 'close', 'gets', 'read', 'catch', 'info', 'regexp',
      'regsub',
    ],
    'constant.builtin': ['stdin', 'stdout', 'stderr'],
  },
}
