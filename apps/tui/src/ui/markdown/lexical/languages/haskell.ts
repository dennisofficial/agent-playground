import { blockComment, dashComment, doubleQuoted, pattern, quoted } from '../rules'
import type { LanguageSpec } from '../spec'

const MODULE_PATH = /[A-Z][A-Za-z0-9_']*(?:\.[A-Z][A-Za-z0-9_']*)+/
const MODULE_QUALIFIER = /[A-Z][A-Za-z0-9_']*(?=\.[a-z_])/
const TYPE_NAME = /[A-Z][A-Za-z0-9_']*/
const CHARACTER_LITERAL = /'(?:\\[^\n]|[^\\'\n])'/
const PRIMED_NAME = /[a-z_][A-Za-z0-9_']*/
const SYMBOL_OPERATORS = '!#$%&*+./<=>?@\\^|-~:'
const DASH_LED_OPERATOR = /-{2,}[!#$%&*+.\/<=>?@\\^|~:][-!#$%&*+.\/<=>?@\\^|~:]*/

export const haskell: LanguageSpec = {
  filetype: 'haskell',
  aliases: ['hs'],
  call: 'function.call',
  rules: [
    quoted({ open: '{-#', close: '#-}', escape: null, multiline: true, group: 'attribute' }),
    blockComment({ open: '{-', close: '-}', nests: true }),
    pattern({ match: DASH_LED_OPERATOR, group: 'operator' }),
    dashComment(),
    doubleQuoted(),
    pattern({ match: CHARACTER_LITERAL, group: 'character' }),
    pattern({ match: MODULE_PATH, group: 'module' }),
    pattern({ match: MODULE_QUALIFIER, group: 'module' }),
    pattern({ match: TYPE_NAME, group: 'type' }),
  ],
  identifier: PRIMED_NAME,
  operators: SYMBOL_OPERATORS,
  words: {
    keyword: [
      'module', 'where', 'import', 'qualified', 'hiding', 'as', 'data', 'newtype', 'type', 'class',
      'instance', 'deriving', 'let', 'in', 'do', 'mdo', 'rec', 'forall', 'family', 'foreign',
      'infix', 'infixl', 'infixr', 'pattern', 'stock', 'anyclass', 'via', 'default',
    ],
    conditional: ['case', 'of', 'if', 'then', 'else'],
    'function.builtin': [
      'print', 'putStr', 'putStrLn', 'getLine', 'show', 'read', 'error', 'map', 'filter', 'foldr',
      'foldl', 'zipWith', 'length', 'reverse', 'concat', 'concatMap', 'elem', 'fromIntegral',
      'return', 'pure', 'fmap', 'mapM_', 'sequence_', 'id', 'const', 'not', 'seq',
    ],
    'constant.builtin': ['otherwise', 'undefined'],
  },
}
