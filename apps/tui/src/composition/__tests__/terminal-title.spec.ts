import { describe, expect, it } from 'bun:test'

import { terminalTitleSequence } from '../terminal-title'

describe('terminalTitleSequence', () => {
  it('wraps the thread title in an OSC 0 sequence', () => {
    expect(terminalTitleSequence({ name: 'Refresh token rotation', directory: '/dev/atlas' })).toBe(
      '\x1b]0;Refresh token rotation\x07',
    )
  })

  it('falls back to the directory basename when the thread is unnamed', () => {
    expect(terminalTitleSequence({ name: null, directory: '/dev/atlas' })).toBe(
      '\x1b]0;atlas\x07',
    )
  })

  it('ignores trailing slashes on the directory fallback', () => {
    expect(terminalTitleSequence({ name: null, directory: '/dev/atlas/' })).toBe(
      '\x1b]0;atlas\x07',
    )
  })

  it('keeps the filesystem root as its own fallback', () => {
    expect(terminalTitleSequence({ name: null, directory: '/' })).toBe('\x1b]0;/\x07')
  })

  it('strips control characters so a title cannot inject escape sequences', () => {
    expect(
      terminalTitleSequence({ name: 'bold \x1b[1mwww\x1b]0;evil\x07', directory: '/dev/atlas' }),
    ).toBe('\x1b]0;bold [1mwww ]0;evil\x07')
  })

  it('collapses newlines and whitespace runs in the title', () => {
    expect(terminalTitleSequence({ name: 'one\n  two\tthree', directory: '/dev/atlas' })).toBe(
      '\x1b]0;one two three\x07',
    )
  })
})
