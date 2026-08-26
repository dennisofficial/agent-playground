import {
  annotation,
  doubleQuoted,
  quoted,
  singleQuoted,
  slashComments,
  tripleQuoted,
  typeByCase,
} from '../rules'
import type { LanguageSpec } from '../spec'

export const dart: LanguageSpec = {
  filetype: 'dart',
  call: 'function.call',
  rules: [
    ...slashComments(),
    tripleQuoted(),
    quoted({ open: "'''", escape: null, multiline: true }),
    quoted({ open: 'r"""', close: '"""', escape: null, multiline: true }),
    quoted({ open: "r'''", close: "'''", escape: null, multiline: true }),
    quoted({ open: 'r"', close: '"', escape: null }),
    quoted({ open: "r'", close: "'", escape: null }),
    doubleQuoted(),
    singleQuoted(),
    annotation(),
    typeByCase(),
  ],
  identifier: /[A-Za-z_$][A-Za-z0-9_$]*/,
  operators: '+-*/%<>=!&|^~?',
  words: {
    keyword: [
      'abstract', 'as', 'assert', 'async', 'await', 'base', 'break', 'case', 'catch', 'class',
      'const', 'continue', 'covariant', 'default', 'deferred', 'do', 'else', 'enum', 'export',
      'extends', 'extension', 'external', 'factory', 'final', 'finally', 'for', 'get', 'hide',
      'if', 'implements', 'import', 'in', 'interface', 'is', 'late', 'library', 'mixin', 'new',
      'on', 'operator', 'part', 'required', 'rethrow', 'return', 'sealed', 'set', 'show', 'static',
      'switch', 'sync', 'throw', 'try', 'typedef', 'var', 'when', 'while', 'with', 'yield',
    ],
    type: ['bool', 'double', 'dynamic', 'int', 'num', 'void'],
    'constant.builtin': ['false', 'null', 'super', 'this', 'true'],
    'function.builtin': ['identical', 'print'],
  },
}
