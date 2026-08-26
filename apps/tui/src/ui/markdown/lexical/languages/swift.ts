import {
  annotation,
  blockComment,
  doubleQuoted,
  lineComment,
  pattern,
  quoted,
  sigilVariable,
  tripleQuoted,
  typeByCase,
} from '../rules'
import type { LanguageSpec } from '../spec'

export const swift: LanguageSpec = {
  filetype: 'swift',
  call: 'function.call',
  rules: [
    lineComment({ open: '//' }),
    blockComment({ open: '/*', close: '*/', nests: true }),
    tripleQuoted(),
    quoted({ open: '#"', close: '"#', escape: null }),
    doubleQuoted(),
    pattern({ match: /#[A-Za-z_][A-Za-z0-9_]*/, group: 'keyword.directive' }),
    annotation(),
    sigilVariable({ sigil: '$', word: '[A-Za-z0-9_]+' }),
    pattern({ match: /`[A-Za-z_][A-Za-z0-9_]*`/, group: 'variable' }),
    pattern({ match: /Self(?![A-Za-z0-9_])/, group: 'constant.builtin' }),
    typeByCase(),
  ],
  words: {
    keyword: [
      'actor', 'any', 'as', 'associatedtype', 'async', 'await', 'break', 'case', 'catch', 'class',
      'continue', 'convenience', 'default', 'defer', 'deinit', 'didSet', 'do', 'dynamic', 'else',
      'enum', 'extension', 'fallthrough', 'fileprivate', 'final', 'for', 'func', 'get', 'guard',
      'if', 'import', 'in', 'indirect', 'infix', 'init', 'inout', 'internal', 'is', 'isolated',
      'lazy', 'let', 'mutating', 'nonisolated', 'nonmutating', 'open', 'operator', 'override',
      'postfix', 'precedencegroup', 'prefix', 'private', 'protocol', 'public', 'repeat',
      'required', 'rethrows', 'return', 'set', 'some', 'static', 'struct', 'subscript', 'switch',
      'throw', 'throws', 'try', 'typealias', 'unowned', 'var', 'weak', 'where', 'while', 'willSet',
    ],
    'constant.builtin': ['nil', 'true', 'false', 'self', 'super'],
  },
}
