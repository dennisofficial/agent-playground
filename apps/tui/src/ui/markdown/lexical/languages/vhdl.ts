import { blockComment, dashComment, pattern, quoted } from '../rules'
import type { LanguageSpec } from '../spec'

export const vhdl: LanguageSpec = {
  filetype: 'vhdl',
  aliases: ['vhd'],
  call: 'function.call',
  caseInsensitive: true,
  rules: [
    dashComment(),
    blockComment({ open: '/*', close: '*/' }),
    pattern({ match: /\d*[UuSs]?[BbOoXxDd]"[0-9A-Fa-f_]*"/, group: 'number' }),
    quoted({ open: '"', escape: null, doubled: true }),
    pattern({ match: /'[A-Za-z_][A-Za-z0-9_]+/, group: 'attribute' }),
    pattern({ match: /'[^'\n]'/, group: 'character' }),
    pattern({ match: /:=/, group: 'operator' }),
  ],
  number: /(?:\d[\d_]*#[0-9A-Fa-f_]+#|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)/,
  operators: '+-*/&<>=|?',
  words: {
    keyword: [
      'abs', 'access', 'after', 'alias', 'all', 'and', 'architecture', 'array', 'assert',
      'attribute', 'begin', 'block', 'body', 'buffer', 'bus', 'case', 'component',
      'configuration', 'constant', 'context', 'default', 'disconnect', 'downto', 'else',
      'elsif', 'end', 'entity', 'exit', 'file', 'for', 'force', 'function', 'generate',
      'generic', 'group', 'guarded', 'if', 'impure', 'in', 'inertial', 'inout', 'instance',
      'is', 'label', 'library', 'linkage', 'literal', 'loop', 'map', 'mod', 'nand', 'new',
      'next', 'nor', 'not', 'null', 'of', 'on', 'open', 'or', 'others', 'out', 'package',
      'parameter', 'port', 'postponed', 'procedure', 'process', 'protected', 'pure', 'range',
      'record', 'register', 'reject', 'rem', 'release', 'report', 'return', 'rol', 'ror',
      'select', 'severity', 'shared', 'signal', 'sla', 'sll', 'sra', 'srl', 'subtype', 'then',
      'to', 'transport', 'type', 'unaffected', 'units', 'until', 'use', 'variable', 'wait',
      'when', 'while', 'with', 'xnor', 'xor',
    ],
    type: [
      'bit', 'bit_vector', 'boolean', 'character', 'integer', 'natural', 'positive', 'real',
      'severity_level', 'signed', 'std_logic', 'std_logic_vector', 'std_ulogic',
      'std_ulogic_vector', 'string', 'time', 'unsigned',
    ],
    boolean: ['true', 'false'],
    'constant.builtin': ['note', 'warning', 'error', 'failure'],
    'function.builtin': [
      'rising_edge', 'falling_edge', 'resize', 'to_integer', 'to_signed', 'to_unsigned',
      'to_stdlogicvector', 'shift_left', 'shift_right', 'deallocate', 'readline', 'writeline',
      'now',
    ],
  },
}
