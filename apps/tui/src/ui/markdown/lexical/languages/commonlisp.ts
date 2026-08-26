import { blockComment, doubleQuoted, pattern, semicolonComment } from '../rules'
import type { LanguageSpec } from '../spec'

const SYMBOL_HEAD = 'A-Za-z0-9_*+/<>=!?%&-'
const SYMBOL_TAIL = 'A-Za-z0-9_*+/<>=!?%&:-'
const SYMBOL = `[${SYMBOL_HEAD}][${SYMBOL_TAIL}]*`

const DEFINES_FUNCTION = 'defun|defmacro|defmethod|defgeneric|defsetf'
const DEFINES_TYPE = 'defclass|defstruct|deftype|define-condition'

const symbol = new RegExp(SYMBOL)
const definedFunction = new RegExp(`(?<=\\((?:${DEFINES_FUNCTION})\\s+)${SYMBOL}`, 'i')
const definedType = new RegExp(`(?<=\\((?:${DEFINES_TYPE})\\s+)${SYMBOL}`, 'i')
const sharpQuotedFunction = new RegExp(`#'${SYMBOL}`)
const keywordSymbol = new RegExp(`:[${SYMBOL_TAIL}]+`)
const earmuffedVariable = new RegExp(`\\*[A-Za-z][${SYMBOL_TAIL}]*\\*`)
const numberLiteral = new RegExp(
  `(?:#[xXbBoO][0-9A-Fa-f]+|[+-]?\\d+(?:\\/\\d+|\\.\\d*)?(?:[dDeEsSfFlL][+-]?\\d+)?)(?![${SYMBOL_TAIL}])`,
)

export const commonlisp: LanguageSpec = {
  filetype: 'commonlisp',
  aliases: ['lisp', 'cl', 'elisp'],
  caseInsensitive: true,
  rules: [
    blockComment({ open: '#|', close: '|#', nests: true }),
    semicolonComment(),
    doubleQuoted(),
    pattern({ match: sharpQuotedFunction, group: 'function' }),
    pattern({ match: /#\\(?:[A-Za-z][A-Za-z0-9-]*|.)/, group: 'character' }),
    pattern({ match: definedFunction, group: 'function' }),
    pattern({ match: definedType, group: 'type' }),
    pattern({ match: keywordSymbol, group: 'string.special.symbol' }),
    pattern({ match: earmuffedVariable, group: 'variable' }),
    pattern({ match: numberLiteral, group: 'number' }),
  ],
  identifier: symbol,
  operators: '',
  words: {
    keyword: [
      'defun', 'defvar', 'defparameter', 'defconstant', 'defmacro', 'defclass', 'defmethod',
      'defgeneric', 'defstruct', 'defpackage', 'defsetf', 'deftype', 'define-condition',
      'in-package', 'let', 'let*', 'flet', 'labels', 'macrolet', 'symbol-macrolet', 'lambda',
      'setf', 'setq', 'psetq', 'incf', 'decf', 'push', 'pushnew', 'pop', 'if', 'when', 'unless',
      'cond', 'case', 'ecase', 'ccase', 'typecase', 'etypecase', 'and', 'or', 'loop', 'do', 'do*',
      'dolist', 'dotimes', 'progn', 'prog1', 'prog2', 'return', 'return-from', 'block', 'tagbody',
      'go', 'catch', 'throw', 'quote', 'function', 'multiple-value-bind', 'destructuring-bind',
      'eval-when', 'handler-case', 'handler-bind', 'restart-case', 'ignore-errors',
      'unwind-protect', 'with-slots', 'with-accessors', 'with-open-file',
      'with-output-to-string', 'assert', 'check-type', 'declare', 'declaim', 'the', '&optional',
      '&rest', '&key', '&body', '&aux', '&allow-other-keys', '&environment', '&whole',
    ],
    'constant.builtin': ['t', 'nil'],
    'function.builtin': [
      '+', '-', '*', '/', '=', '/=', '<', '>', '<=', '>=', '1+', '1-', 'format', 'princ', 'print',
      'prin1', 'write-line', 'terpri', 'list', 'list*', 'cons', 'car', 'cdr', 'caar', 'cadr',
      'first', 'second', 'rest', 'last', 'nth', 'elt', 'aref', 'append', 'reverse', 'length',
      'mapcar', 'mapc', 'mapcan', 'reduce', 'remove', 'remove-if', 'find', 'find-if', 'position',
      'sort', 'funcall', 'apply', 'eq', 'eql', 'equal', 'equalp', 'null', 'not', 'error', 'warn',
      'values', 'make-instance', 'slot-value', 'make-array', 'make-hash-table', 'gethash',
      'concatenate', 'coerce', 'floor', 'ceiling', 'round', 'truncate', 'mod', 'rem', 'expt',
      'sqrt', 'abs', 'max', 'min', 'zerop', 'plusp', 'minusp', 'oddp', 'evenp', 'atom', 'consp',
      'listp', 'numberp', 'stringp', 'symbolp', 'functionp',
    ],
  },
}
