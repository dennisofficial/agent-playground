import { describe, expect, it } from 'bun:test'

import { stripAnsi } from '../ansi'

describe('what a transcript row keeps of a terminal’s output', () => {
  it('strips colour and weight but keeps the words', () => {
    expect(stripAnsi('\x1b[31m✗ 3 fail\x1b[0m \x1b[1mpass\x1b[22m')).toBe('✗ 3 fail pass')
  })

  it('strips an operating-system command like a window-title set', () => {
    expect(stripAnsi('\x1b]0;building…\x07real output')).toBe('real output')
  })

  it('drops the carriage returns a progress line rewrites itself with', () => {
    expect(stripAnsi('10%\r40%\r100%\rdone')).toBe('10%40%100%done')
  })

  it('leaves plain text exactly as it came', () => {
    expect(stripAnsi('plain output\nsecond line')).toBe('plain output\nsecond line')
  })
})
