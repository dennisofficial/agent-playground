import { doubleQuoted, pattern, preprocessor, quoted, slashComments, typeByCase } from '../rules'
import type { LanguageSpec } from '../spec'

const AT_KEYWORD =
  /@(?:autoreleasepool|compatibility_alias|implementation|interface|synchronized|synthesize|protected|protocol|available|optional|property|required|selector|dynamic|encode|finally|import|package|private|public|throw|catch|class|defs|end|try)\b/

const UPPERCASE_CONSTANT = /(?:YES|NO|NULL|Nil|TRUE|FALSE)\b/

const FOUNDATION_CALL =
  /NS(?:Log|Assert|StringFromClass|StringFromSelector|StringFromRect|MakeRange|LocalizedString)\b/

const UPPERCASE_CALL = /[A-Z][A-Za-z0-9_]*(?=\()/

const CHAR_LITERAL = /'(?:\\.|[^\\'\n])+'/

const INCLUDE_PATH = /<[A-Za-z0-9_+./-]+\.h>/

export const objc: LanguageSpec = {
  filetype: 'objc',
  aliases: ['objectivec', 'objective-c'],
  call: 'function.call',
  rules: [
    ...slashComments(),
    preprocessor(),
    pattern({ match: INCLUDE_PATH, group: 'string' }),
    quoted({ open: '@"', close: '"' }),
    doubleQuoted(),
    pattern({ match: CHAR_LITERAL, group: 'character' }),
    pattern({ match: AT_KEYWORD, group: 'keyword' }),
    pattern({ match: UPPERCASE_CONSTANT, group: 'constant.builtin' }),
    pattern({ match: FOUNDATION_CALL, group: 'function.builtin' }),
    pattern({ match: UPPERCASE_CALL, group: 'function.call' }),
    typeByCase(),
  ],
  words: {
    keyword: [
      'break', 'case', 'continue', 'default', 'do', 'else', 'enum', 'for', 'goto', 'if', 'in',
      'inout', 'oneway', 'return', 'sizeof', 'struct', 'switch', 'typedef', 'union', 'while',
    ],
    type: [
      'bool', 'char', 'double', 'float', 'id', 'instancetype', 'int', 'long', 'short', 'signed',
      'unichar', 'unsigned', 'void', '_Bool',
    ],
    'type.qualifier': [
      'atomic', 'const', 'getter', 'nonatomic', 'nonnull', 'nullable', 'readonly', 'readwrite',
      'restrict', 'setter', 'strong', 'weak', '_Nonnull', '_Nullable',
    ],
    storageclass: [
      '__autoreleasing', '__block', '__bridge', '__strong', '__unsafe_unretained', '__weak', 'auto',
      'extern', 'inline', 'register', 'static', 'volatile',
    ],
    'constant.builtin': ['nil', 'self', 'super'],
  },
}
