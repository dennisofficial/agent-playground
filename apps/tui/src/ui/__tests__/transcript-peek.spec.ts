import { describe, expect, it } from 'bun:test'

import { firstLineOf, peekAbove } from '../transcript-peek'

const CANDIDATES = [
  { key: 'u1', top: 0 },
  { key: 'u2', top: 40 },
  { key: 'u3', top: 90 },
]

describe('the message held at the top edge', () => {
  it('is the last one whose top has scrolled past it', () => {
    expect(peekAbove({ candidates: CANDIDATES, viewportTop: 60 })).toBe('u2')
  })

  it('is nothing while the first message is still fully in view', () => {
    expect(peekAbove({ candidates: CANDIDATES, viewportTop: 0 })).toBe(null)
  })

  it('lets go of a message the moment its own top lands on the edge', () => {
    expect(peekAbove({ candidates: CANDIDATES, viewportTop: 40 })).toBe('u1')
  })

  it('holds the newest once every message is above the edge', () => {
    expect(peekAbove({ candidates: CANDIDATES, viewportTop: 400 })).toBe('u3')
  })

  it('has nothing to hold when nothing qualifies', () => {
    expect(peekAbove({ candidates: [], viewportTop: 400 })).toBe(null)
  })
})

describe('what the peek says', () => {
  it('takes the first line that carries words', () => {
    expect(firstLineOf('\n\n  port the transcript\nand keep sticky scroll')).toBe(
      'port the transcript',
    )
  })

  it('collapses the run of spaces a wrapped paste leaves behind', () => {
    expect(firstLineOf('port   the\ttranscript')).toBe('port the transcript')
  })

  it('says nothing for a message that is only whitespace', () => {
    expect(firstLineOf('\n   \n')).toBe('')
  })
})
