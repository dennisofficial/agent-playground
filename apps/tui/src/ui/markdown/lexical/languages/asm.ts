import {
  blockComment,
  doubleQuoted,
  hashComment,
  pattern,
  semicolonComment,
  singleQuoted,
} from '../rules'
import type { LanguageSpec } from '../spec'

const GAS_SUFFIXED_MNEMONIC =
  /(?:mov|movz|movs|lea|add|sub|adc|sbb|imul|mul|idiv|div|inc|dec|neg|and|or|xor|not|shl|shr|sal|sar|rol|ror|cmp|test|push|pop|call|jmp|ret|set|cmov|stos|lods|scas|rep)(?:[bwlq]{1,2}|s[bwlq]|z[bwlq])(?![A-Za-z0-9_])/

export const asm: LanguageSpec = {
  filetype: 'asm',
  aliases: ['assembly', 'nasm', 'x86asm', 'gas'],
  caseInsensitive: true,
  rules: [
    semicolonComment(),
    hashComment(),
    blockComment({ open: '/*', close: '*/' }),
    doubleQuoted(),
    singleQuoted(),
    pattern({ match: /[A-Za-z_.$][A-Za-z0-9_.$]*:/, group: 'label', atLineStart: true }),
    pattern({ match: /\.[A-Za-z_][A-Za-z0-9_]*/, group: 'keyword.directive' }),
    pattern({ match: /\d[0-9A-Fa-f]*[hH](?![0-9A-Za-z_])/, group: 'number' }),
    pattern({ match: GAS_SUFFIXED_MNEMONIC, group: 'function' }),
  ],
  words: {
    keyword: [
      'section', 'segment', 'global', 'extern', 'bits', 'org', 'align', 'times', 'equ', 'db', 'dw',
      'dd', 'dq', 'dt', 'resb', 'resw', 'resd', 'resq', 'incbin', 'byte', 'word', 'dword', 'qword',
      'ptr', 'offset', 'short', 'near', 'far',
    ],
    'variable.builtin': [
      'eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'esp', 'ebp',
      'rax', 'rbx', 'rcx', 'rdx', 'rsi', 'rdi', 'rsp', 'rbp',
      'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15',
      'ax', 'bx', 'cx', 'dx', 'al', 'ah', 'bl', 'bh', 'cl', 'ch', 'dl', 'dh', 'si', 'di',
      'xmm0', 'xmm1', 'xmm2', 'xmm3', 'xmm4', 'xmm5', 'xmm6', 'xmm7',
      'cs', 'ds', 'es', 'fs', 'gs', 'ss', 'eflags', 'rip',
    ],
    function: [
      'mov', 'movzx', 'movsx', 'lea', 'add', 'sub', 'adc', 'sbb', 'mul', 'imul', 'div', 'idiv',
      'inc', 'dec', 'neg', 'and', 'or', 'xor', 'not', 'shl', 'shr', 'sal', 'sar', 'rol', 'ror',
      'cmp', 'test', 'jmp', 'je', 'jne', 'jz', 'jnz', 'jg', 'jge', 'jl', 'jle', 'ja', 'jae', 'jb',
      'jbe', 'call', 'ret', 'push', 'pop', 'pushf', 'popf', 'enter', 'leave', 'nop', 'hlt', 'int',
      'iret', 'syscall', 'sysret', 'cdq', 'cqo', 'setz', 'setnz', 'cmov', 'loop', 'rep', 'repe',
      'repne', 'movs', 'stos', 'lods', 'scas', 'fld', 'fst', 'fadd', 'fsub', 'fmul', 'fdiv',
      'sete', 'setne', 'setg', 'setge', 'setl', 'setle', 'seta', 'setae', 'setb', 'setbe',
      'cmove', 'cmovne', 'cmovg', 'cmovge', 'cmovl', 'cmovle', 'cmova', 'cmovae', 'cmovb', 'cmovbe',
    ],
  },
}
