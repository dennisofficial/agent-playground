import { describe, expect, it } from 'bun:test'

import { expectLexes, expectPlain, groupsIn, textFor } from '../../__tests__/harness'
import { asm as spec } from '../asm'

const source = [
  '; a calculator in nasm, x86-64 sysv',
  '        bits 64',
  '',
  '        section .data',
  'scale:  dq      2',
  "fmt:    db      '%ld', 10, 0",
  'banner: db      "calc", 0',
  'STEP    equ     3',
  '',
  '        section .bss',
  'total:  resq    1',
  '',
  '        section .text',
  '        global  main',
  '        extern  printf',
  '',
  'add_ints:',
  '        mov     rax, rdi',
  '        add     rax, rsi',
  '        ret',
  '',
  'multiply:',
  '        mov     rax, rdi',
  '        imul    rax, rsi',
  '        imul    rax, qword [rel scale]',
  '        ret',
  '',
  'main:',
  '        push    rbp',
  '        mov     rbp, rsp',
  '        sub     rsp, 16',
  '        mov     rax, [fs:0x28]',
  '        mov     [rbp-8], rax',
  '',
  '        lea     rdi, [rel banner]',
  '        xor     eax, eax',
  '        call    printf',
  '',
  '        mov     edi, STEP',
  '        mov     esi, 5',
  '        call    add_ints',
  '        mov     edi, eax',
  '        mov     esi, 3',
  '        call    multiply',
  '        mov     [rel total], rax',
  '',
  '        lea     rdi, [rel fmt]',
  '        mov     esi, eax',
  '        xor     eax, eax',
  '        call    printf',
  '',
  '        add     rsp, 16',
  '        pop     rbp',
  '',
  '        cmp     eax, 0',
  '        setl    al',
  '        movzx   edi, al',
  '        mov     eax, 3Ch                ; exit(status)',
  '        syscall',
  '',
].join('\n')

const gasSource = [
  '/* multiply(%rdi, %rsi) -> %rax; movq below does the work */',
  '        .text',
  '        .globl  multiply',
  '        .type   multiply, @function',
  'multiply:',
  '        pushq   %rbp',
  '        movq    %rsp, %rbp',
  '        movq    %rdi, %rax',
  '        imulq   %rsi, %rax',
  '        movzbl  (%rdi), %edx',
  '        addq    $1, %rax',
  '        popq    %rbp',
  '        ret                     # tail',
  '',
].join('\n')

describe('asm lexical highlighting', () => {
  it('lexes a representative sample', () => {
    expectLexes({
      spec,
      source,
      groups: [
        'comment',
        'string',
        'label',
        'keyword',
        'keyword.directive',
        'variable.builtin',
        'function',
        'number',
        'operator',
      ],
    })
  })

  it('reads a name followed by a colon at the head of a line as a label', () => {
    expect(textFor({ spec, source, group: 'label' })).toEqual([
      'scale:',
      'fmt:',
      'banner:',
      'total:',
      'add_ints:',
      'multiply:',
      'main:',
    ])
  })

  it('reads a dot-led section directive as a directive', () => {
    expect(textFor({ spec, source, group: 'keyword.directive' })).toEqual([
      '.data',
      '.bss',
      '.text',
    ])
  })

  it('reads both string flavours', () => {
    expect(textFor({ spec, source, group: 'string' })).toEqual(["'%ld'", '"calc"'])
  })

  it('reads a semicolon comment to end of line', () => {
    expect(textFor({ spec, source, group: 'comment' })).toEqual([
      '; a calculator in nasm, x86-64 sysv',
      '; exit(status)',
    ])
  })

  it('reads an h-suffixed digit run as a number', () => {
    const numbers = 'mov eax, 3Ch\nand eax, 0FFh\nmov ebx, 0x1F\nmov ecx, 42'
    expect(textFor({ spec, source: numbers, group: 'number' })).toEqual([
      '3Ch',
      '0FFh',
      '0x1F',
      '42',
    ])
  })

  it('reads the condition-code mnemonics as instructions', () => {
    const setcc = 'cmp rax, rsi\nsetne al\nsete bl\ncmovne rax, rsi\ncmovle rdi, rax'
    expect(textFor({ spec, source: setcc, group: 'function' })).toEqual([
      'cmp',
      'setne',
      'sete',
      'cmovne',
      'cmovle',
    ])
  })

  it('reads a gas block comment whole and does not lex the code inside it', () => {
    expect(textFor({ spec, source: gasSource, group: 'comment' })).toEqual([
      '/* multiply(%rdi, %rsi) -> %rax; movq below does the work */',
      '# tail',
    ])
    expect(textFor({ spec, source: gasSource, group: 'function' })).toEqual([
      'pushq',
      'movq',
      'movq',
      'imulq',
      'movzbl',
      'addq',
      'popq',
      'ret',
    ])
  })

  it('spans a gas block comment across lines', () => {
    const banner = '/*\n * multiply: rdi * rsi\n */\n        imulq   %rsi, %rax'
    expect(textFor({ spec, source: banner, group: 'comment' })).toEqual([
      '/*\n * multiply: rdi * rsi\n */',
    ])
  })

  it('reads a percent-prefixed gas register as a register', () => {
    expect(textFor({ spec, source: '        movq    %rsp, %rbp', group: 'variable.builtin' })).toEqual([
      'rsp',
      'rbp',
    ])
  })

  it('folds uppercase mnemonics, registers and directives', () => {
    expect([...groupsIn({ spec, source: 'MOV EAX, DWORD [EBX]' })].sort()).toEqual([
      'function',
      'keyword',
      'variable.builtin',
    ])
  })

  it('keeps a slash division operator out of the block comment rule', () => {
    expect(textFor({ spec, source: 'mov eax, SIZE/4', group: 'comment' })).toEqual([])
    expect(textFor({ spec, source: 'mov eax, SIZE/4', group: 'operator' })).toEqual(['/'])
  })

  it('does not read a semicolon inside a string as a comment', () => {
    const line = 'msg:    db      "a;b", 0'
    expect(textFor({ spec, source: line, group: 'comment' })).toEqual([])
    expect(textFor({ spec, source: line, group: 'string' })).toEqual(['"a;b"'])
  })

  it('leaves an ordinary symbol operand alone', () => {
    expectPlain({ spec, source, text: 'main' })
  })

  it('leaves an uppercase constant at the head of a line alone', () => {
    expectPlain({ spec, source, text: 'STEP' })
  })

  it('does not read a segment override as a label', () => {
    expectPlain({ spec, source: 'mov rax, [fs:0x28]', text: ':0x28' })
  })

  it('answers to every flavour spelling', () => {
    expect(spec.aliases).toEqual(['assembly', 'nasm', 'x86asm', 'gas'])
    for (const alias of spec.aliases ?? []) expect(alias).toBe(alias.toLowerCase())
  })
})
