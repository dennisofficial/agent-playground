import { lineComment, quoted } from '../rules'
import type { LanguageSpec } from '../spec'

const INDICATOR_COLUMN = 6

export const cobol: LanguageSpec = {
  filetype: 'cobol',
  aliases: ['cbl', 'cob'],
  caseInsensitive: true,
  identifier: /[A-Za-z_][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)*/,
  rules: [
    lineComment({ open: '*>' }),
    lineComment({ open: '*', atColumn: INDICATOR_COLUMN }),
    lineComment({ open: '/', atColumn: INDICATOR_COLUMN }),
    quoted({ open: '"', escape: null, doubled: true }),
    quoted({ open: "'", escape: null, doubled: true }),
  ],
  words: {
    keyword: [
      'identification', 'division', 'program-id', 'author', 'installation', 'date-written',
      'environment', 'configuration', 'source-computer', 'object-computer', 'special-names',
      'input-output', 'file-control', 'data', 'file', 'fd', 'sd', 'working-storage',
      'local-storage', 'linkage', 'report', 'screen', 'section', 'procedure', 'pic', 'picture',
      'value', 'values', 'occurs', 'redefines', 'renames', 'filler', 'usage', 'comp', 'comp-1',
      'comp-2', 'comp-3', 'comp-4', 'comp-5', 'computational', 'computational-3', 'binary',
      'packed-decimal', 'signed', 'unsigned', 'sign', 'separate', 'blank', 'justified',
      'synchronized', 'global', 'external', 'display', 'move', 'to', 'from', 'giving',
      'remainder', 'add', 'subtract', 'multiply', 'divide', 'by', 'into', 'compute', 'accept',
      'perform', 'varying', 'thru', 'through', 'times', 'until', 'test', 'if', 'then', 'else',
      'end-if', 'evaluate', 'when', 'also', 'other', 'end-evaluate', 'open', 'close', 'read',
      'write', 'rewrite', 'delete', 'start', 'stop', 'run', 'go', 'call', 'cancel', 'using',
      'returning', 'goback', 'exit', 'program', 'continue', 'next', 'sentence', 'initialize',
      'set', 'inspect', 'string', 'unstring', 'search', 'sort', 'merge', 'replacing',
      'tallying', 'delimited', 'pointer', 'count', 'end', 'end-add', 'end-subtract',
      'end-multiply', 'end-divide', 'end-compute', 'end-perform', 'end-read', 'end-write',
      'end-call', 'end-search', 'end-string', 'end-unstring', 'end-accept', 'end-display',
      'not', 'and', 'or', 'is', 'are', 'of', 'in', 'no', 'at', 'with', 'after', 'before',
      'advancing', 'depending', 'on', 'ascending', 'descending', 'greater', 'less', 'equal',
      'than', 'numeric', 'alphabetic', 'select', 'assign', 'organization', 'sequential',
      'relative', 'indexed', 'dynamic', 'access', 'mode', 'record', 'records', 'key', 'index',
      'status', 'label', 'standard', 'omitted', 'line', 'lines', 'page', 'size', 'all',
      'leading', 'trailing', 'characters', 'date', 'time', 'invalid', 'overflow', 'exception',
      'function', 'invoke', 'copy', 'replace',
    ],
    'constant.builtin': [
      'zero', 'zeros', 'zeroes', 'space', 'spaces', 'high-value', 'high-values', 'low-value',
      'low-values', 'quote', 'quotes', 'null', 'nulls',
    ],
    boolean: ['true', 'false'],
  },
}
