import { describe, expect, it } from 'bun:test'

import { looksLikePrompt } from '../prompt-sniff'

describe('telling a shell waiting on input from one merely working', () => {
  for (const tail of [
    'Password: ',
    'Enter passphrase for key: ',
    'Overwrite existing file? (y/n) ',
    'Are you sure you want to continue?',
    'Press ENTER to continue',
    'Select an option',
    '? Which package manager >',
    'mysql>',
    '$',
    '[1] #',
  ]) {
    it(`reads ${JSON.stringify(tail)} as a prompt`, () => {
      expect(looksLikePrompt(`some earlier work\n${tail}`)).toBe(true)
    })
  }

  it('reads nothing as not a prompt', () => {
    expect(looksLikePrompt('')).toBe(false)
  })

  it('refuses output that ended in a newline, however prompt-like the last line reads', () => {
    expect(looksLikePrompt('Password: \n')).toBe(false)
    expect(looksLikePrompt('Continue? (y/n)\n')).toBe(false)
  })

  for (const tail of [
    'Compiled 42 modules',
    'listening on http://localhost:3000',
    'waiting for changes',
  ]) {
    it(`reads ${JSON.stringify(tail)} as ordinary progress`, () => {
      expect(looksLikePrompt(`building\n${tail}`)).toBe(false)
    })
  }

  it('refuses a last line that is only whitespace', () => {
    expect(looksLikePrompt('done\n   ')).toBe(false)
  })

  it('looks only at the last line, so an earlier prompt-like line does not count', () => {
    expect(looksLikePrompt('Password: accepted\nnow compiling module 3')).toBe(false)
  })

  it('finds a prompt past a long run of preceding output', () => {
    expect(looksLikePrompt(`${'progress\n'.repeat(400)}Continue? (y/N) `)).toBe(true)
  })
})
