import { describe, expect, it } from 'bun:test'

import { pastedLabel, tokenizablePaste, substitutePastedTokens } from '../composer-tokens'

describe('a pasted block of text', () => {
  it('is tokenised once it is longer than a few lines', () => {
    expect(tokenizablePaste('one\ntwo\nthree\nfour')).toBe(false)
    expect(tokenizablePaste('one\ntwo\nthree\nfour\nfive')).toBe(true)
    expect(tokenizablePaste('one short line')).toBe(false)
  })

  it('labels its rank and its line count', () => {
    expect(pastedLabel(1, 3)).toBe('[Pasted text #1 +3 lines]')
  })

  it('substitutes its content back into the message right to left', () => {
    const text = 'alpha [Pasted text #1 +3 lines] mid [Pasted text #2 +2 lines] omega'
    const one = text.indexOf('#1')
    const two = text.indexOf('#2')
    expect(one).not.toBe(-1)

    const tokens = [
      {
        id: 1,
        start: text.indexOf('[Pasted text #1'),
        end: text.indexOf('[Pasted text #1') + '[Pasted text #1 +3 lines]'.length,
        ordinal: 0,
        slot: {
          kind: 'pasted' as const,
          label: '[Pasted text #1 +3 lines]',
          content: 'one\ntwo\nthree',
        },
      },
      {
        id: 2,
        start: text.indexOf('[Pasted text #2'),
        end: text.indexOf('[Pasted text #2') + '[Pasted text #2 +2 lines]'.length,
        ordinal: 0,
        slot: {
          kind: 'pasted' as const,
          label: '[Pasted text #2 +2 lines]',
          content: 'x\ny',
        },
      },
    ]

    expect(substitutePastedTokens({ text, tokens })).toBe('alpha one\ntwo\nthree mid x\ny omega')
    expect(two).not.toBe(one)
  })
})
