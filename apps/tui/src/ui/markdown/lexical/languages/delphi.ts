import { blockComment, lineComment, pattern, quoted } from '../rules'
import type { LanguageSpec } from '../spec'

export const delphi: LanguageSpec = {
  filetype: 'delphi',
  aliases: ['dpr', 'objectpascal'],
  caseInsensitive: true,
  call: 'function.call',
  operators: '+-*/=<>@^',
  rules: [
    quoted({ open: '{$', close: '}', group: 'keyword.directive', escape: null, multiline: true }),
    quoted({ open: '(*$', close: '*)', group: 'keyword.directive', escape: null, multiline: true }),
    blockComment({ open: '{', close: '}' }),
    blockComment({ open: '(*', close: '*)' }),
    lineComment({ open: '//' }),
    quoted({ open: "'", escape: null, doubled: true }),
    pattern({ match: /:=/, group: 'operator' }),
    pattern({ match: /#(?:\$[0-9A-Fa-f]+|\d+)/, group: 'character' }),
    pattern({ match: /\$[0-9A-Fa-f]+/, group: 'number' }),
  ],
  words: {
    keyword: [
      'absolute', 'abstract', 'and', 'array', 'as', 'asm', 'assembler', 'automated', 'begin',
      'case', 'cdecl', 'class', 'const', 'constructor', 'default', 'deprecated', 'destructor',
      'dispinterface', 'div', 'do', 'downto', 'dynamic', 'else', 'end', 'except', 'experimental',
      'export', 'exports', 'external', 'far', 'file', 'final', 'finalization', 'finally', 'for',
      'forward', 'function', 'goto', 'helper', 'if', 'implementation', 'implements', 'in',
      'inherited', 'initialization', 'inline', 'interface', 'is', 'label', 'library', 'mod',
      'near', 'nodefault', 'not', 'object', 'of', 'on', 'operator', 'or', 'out', 'overload',
      'override', 'packed', 'pascal', 'platform', 'private', 'procedure', 'program', 'property',
      'protected', 'public', 'published', 'raise', 'read', 'record', 'register', 'reintroduce',
      'repeat', 'requires', 'resourcestring', 'safecall', 'sealed', 'set', 'shl', 'shr', 'static',
      'stdcall', 'stored', 'strict', 'then', 'threadvar', 'to', 'try', 'type', 'unit', 'until',
      'uses', 'var', 'virtual', 'while', 'with', 'write', 'xor',
    ],
    type: [
      'ansichar', 'ansistring', 'boolean', 'byte', 'cardinal', 'char', 'comp', 'currency',
      'double', 'exception', 'extended', 'iinterface', 'int64', 'integer', 'longbool', 'longint',
      'longword', 'nativeint', 'nativeuint', 'olevariant', 'pansichar', 'pchar', 'pointer',
      'pwidechar', 'real', 'shortint', 'shortstring', 'single', 'smallint', 'string', 'tarray',
      'tbytes', 'tcomponent', 'tdatetime', 'tdictionary', 'tform', 'tguid', 'tlist', 'tobject',
      'tpersistent', 'tstream', 'tstringlist', 'tstrings', 'uint64', 'unicodestring', 'variant',
      'widechar', 'widestring', 'word', 'wordbool',
    ],
    'constant.builtin': ['nil', 'true', 'false', 'result', 'self', 'maxint', 'maxlongint'],
    'function.builtin': [
      'abs', 'assigned', 'chr', 'copy', 'dec', 'delete', 'dispose', 'exit', 'fillchar',
      'floattostr', 'format', 'freeandnil', 'halt', 'high', 'inc', 'insert', 'inttostr', 'length',
      'low', 'new', 'ord', 'pos', 'pred', 'readln', 'round', 'setlength', 'sizeof', 'sqr', 'sqrt',
      'strtoint', 'succ', 'trim', 'trunc', 'uppercase', 'writeln',
    ],
  },
}
