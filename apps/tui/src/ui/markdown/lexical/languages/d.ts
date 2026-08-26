import { annotation, blockComment, doubleQuoted, quoted, slashComments, typeByCase } from '../rules'
import type { LanguageSpec } from '../spec'

export const d: LanguageSpec = {
  filetype: 'd',
  aliases: ['dlang'],
  call: 'function.call',
  rules: [
    blockComment({ open: '/+', close: '+/', nests: true }),
    ...slashComments(),
    quoted({ open: 'r"', close: '"', escape: null, multiline: true }),
    quoted({ open: 'q"', close: '"', escape: null, multiline: true }),
    quoted({ open: '`', escape: null, multiline: true }),
    doubleQuoted(),
    quoted({ open: "'", group: 'character' }),
    annotation(),
    typeByCase(),
  ],
  number:
    /(?:0[xX][0-9A-Fa-f_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)[uUlLfFi]*/,
  words: {
    keyword: [
      'alias', 'align', 'asm', 'assert', 'break', 'cast', 'catch', 'class', 'continue', 'debug',
      'delegate', 'delete', 'do', 'enum', 'finally', 'for', 'foreach', 'foreach_reverse',
      'function', 'goto', 'import', 'in', 'interface', 'invariant', 'is', 'mixin', 'module', 'new',
      'out', 'pragma', 'ref', 'return', 'struct', 'template', 'throw', 'try', 'typeid', 'typeof',
      'union', 'unittest', 'version', 'while', 'with', '__traits', '__vector', '__parameters',
    ],
    conditional: ['case', 'default', 'else', 'if', 'switch'],
    storageclass: [
      'abstract', 'auto', 'deprecated', 'export', 'extern', 'final', 'lazy', 'override', 'package',
      'private', 'protected', 'public', 'scope', 'static', 'synchronized', '__gshared',
    ],
    'type.qualifier': ['const', 'immutable', 'inout', 'nothrow', 'pure', 'shared'],
    type: [
      'bool', 'byte', 'cdouble', 'cent', 'cfloat', 'char', 'creal', 'dchar', 'double', 'dstring',
      'float', 'idouble', 'ifloat', 'int', 'ireal', 'long', 'ptrdiff_t', 'real', 'short',
      'size_t', 'string', 'ubyte', 'ucent', 'uint', 'ulong', 'ushort', 'void', 'wchar', 'wstring',
    ],
    'constant.builtin': [
      'false', 'null', 'super', 'this', 'true', '__FILE__', '__FILE_FULL_PATH__', '__FUNCTION__',
      '__LINE__', '__MODULE__', '__PRETTY_FUNCTION__',
    ],
    'function.builtin': [
      'format', 'printf', 'readf', 'readln', 'write', 'writef', 'writefln', 'writeln',
    ],
  },
}
