import { doubleQuoted, pattern, sigilVariable, slashComments } from '../rules'
import type { LanguageSpec } from '../spec'

const SIZED_LITERAL = /(?:\d[\d_]*)?'(?:[sS]?[bBoOdDhH][0-9a-fA-FxXzZ?_]+|[01xXzZ])/
const COMPILER_DIRECTIVE = /`[A-Za-z_][A-Za-z0-9_]*/
const NAMED_PORT = /\.[A-Za-z_][A-Za-z0-9_]*/

export const verilog: LanguageSpec = {
  filetype: 'verilog',
  aliases: ['v', 'systemverilog', 'sv'],
  call: 'function.call',
  rules: [
    pattern({ match: SIZED_LITERAL, group: 'number' }),
    pattern({ match: COMPILER_DIRECTIVE, group: 'keyword.directive' }),
    ...slashComments(),
    doubleQuoted(),
    sigilVariable({ sigil: '$', group: 'function.builtin' }),
    pattern({ match: NAMED_PORT, group: 'property' }),
  ],
  words: {
    keyword: [
      'module', 'endmodule', 'input', 'output', 'inout', 'wire', 'reg', 'logic', 'bit', 'byte',
      'integer', 'int', 'shortint', 'longint', 'real', 'shortreal', 'realtime', 'time', 'string',
      'void', 'event', 'chandle', 'signed', 'unsigned', 'const', 'static', 'automatic', 'ref',
      'local', 'protected', 'specparam', 'tri', 'tri0', 'tri1', 'wand', 'wor', 'supply0',
      'supply1', 'assign', 'always', 'always_ff', 'always_comb', 'always_latch', 'initial',
      'final', 'begin', 'end', 'if', 'else', 'case', 'casex', 'casez', 'endcase', 'default',
      'for', 'while', 'repeat', 'forever', 'foreach', 'do', 'break', 'continue', 'return',
      'unique', 'priority', 'randcase', 'inside', 'with', 'iff', 'solve', 'before', 'parameter',
      'localparam', 'defparam', 'generate', 'endgenerate', 'genvar', 'function', 'endfunction',
      'task', 'endtask', 'posedge', 'negedge', 'edge', 'and', 'or', 'not', 'nand', 'nor', 'xor',
      'xnor', 'buf', 'typedef', 'struct', 'union', 'enum', 'packed', 'interface', 'endinterface',
      'modport', 'package', 'endpackage', 'import', 'export', 'class', 'endclass', 'extends',
      'virtual', 'pure', 'this', 'super', 'new', 'null', 'rand', 'randc', 'constraint',
      'covergroup', 'endgroup', 'assert', 'assume', 'cover', 'property', 'endproperty',
      'sequence', 'endsequence', 'clocking', 'endclocking', 'program', 'endprogram', 'fork',
      'join', 'wait', 'disable', 'force', 'release', 'deassign', 'bind', 'timeunit',
      'timeprecision',
    ],
  },
}
