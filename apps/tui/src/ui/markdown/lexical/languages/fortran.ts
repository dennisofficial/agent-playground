import { lineComment, pattern, quoted, sigilVariable } from '../rules'
import { ELexRule, type LanguageSpec, type PatternRule } from '../spec'

const DOTTED_OPERATORS = 'and|or|not|eqv|neqv|eq|ne|lt|le|gt|ge'
const DOTTED_CONSTANTS = 'true|false'

const LOGICAL_CONSTANT = new RegExp(`\\.(?:${DOTTED_CONSTANTS})\\.`, 'i')
const LOGICAL_OPERATOR = new RegExp(`\\.(?:${DOTTED_OPERATORS})\\.`, 'i')
const DECLARATION_SEPARATOR = /::/

const FORTRAN_NUMBER = new RegExp(
  `\\d+(?:\\.(?!(?:${DOTTED_OPERATORS}|${DOTTED_CONSTANTS})\\.)\\d*)?(?:[ed][+-]?\\d+)?(?:_[A-Za-z0-9_]+)?`,
  'i',
)

const fixedFormLetterComment: PatternRule = {
  kind: ELexRule.pattern,
  match: /[Cc](?![A-Za-z0-9_])(?![ \t]*[=(%:])[^\n]*/,
  group: 'comment',
  atColumn: 0,
}

export const fortran: LanguageSpec = {
  filetype: 'fortran',
  aliases: ['f90', 'f95', 'for'],
  caseInsensitive: true,
  call: 'function.call',
  number: FORTRAN_NUMBER,
  rules: [
    lineComment({ open: '!' }),
    fixedFormLetterComment,
    lineComment({ open: '*', atColumn: 0 }),
    quoted({ open: '"', escape: null, doubled: true }),
    quoted({ open: "'", escape: null, doubled: true }),
    pattern({ match: LOGICAL_CONSTANT, group: 'constant.builtin' }),
    pattern({ match: LOGICAL_OPERATOR, group: 'operator' }),
    pattern({ match: DECLARATION_SEPARATOR, group: 'punctuation' }),
    sigilVariable({ sigil: '%', group: 'variable.member' }),
  ],
  words: {
    keyword: [
      'program', 'end', 'endprogram', 'subroutine', 'endsubroutine', 'function', 'endfunction',
      'module', 'endmodule', 'submodule', 'use', 'only', 'import', 'implicit', 'none', 'type',
      'endtype', 'class', 'dimension', 'allocatable', 'allocate', 'deallocate', 'nullify',
      'pointer', 'target', 'parameter', 'intent', 'in', 'out', 'inout', 'optional', 'save',
      'public', 'private', 'protected', 'external', 'intrinsic', 'interface', 'endinterface',
      'abstract', 'contains', 'procedure', 'result', 'recursive', 'pure', 'elemental',
      'if', 'then', 'else', 'elseif', 'endif', 'do', 'concurrent', 'while', 'enddo', 'cycle',
      'exit', 'select', 'case', 'default', 'endselect', 'associate', 'endassociate', 'block',
      'endblock', 'forall', 'endforall', 'where', 'elsewhere', 'endwhere', 'call', 'return',
      'print', 'write', 'read', 'open', 'close', 'inquire', 'rewind', 'backspace', 'endfile',
      'format', 'namelist', 'stop', 'error', 'common', 'equivalence', 'data', 'go', 'to',
      'continue',
    ],
    type: ['integer', 'real', 'double', 'precision', 'complex', 'character', 'logical'],
    'function.builtin': [
      'abs', 'achar', 'allocated', 'associated', 'huge', 'iachar', 'int', 'kind', 'len', 'len_trim',
      'max', 'min', 'mod', 'nint', 'present', 'selected_real_kind', 'shape', 'size', 'sqrt', 'sum',
      'tiny', 'trim',
    ],
  },
}
