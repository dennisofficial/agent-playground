import { describe, expect, it } from 'bun:test'

import { isWarpTerminal } from '../terminal'

describe('isWarpTerminal', () => {
  it('is true when TERM_PROGRAM is WarpTerminal', () => {
    expect(isWarpTerminal({ env: { TERM_PROGRAM: 'WarpTerminal' } })).toBe(true)
  })

  it('is false for other terminals and when unset', () => {
    expect(isWarpTerminal({ env: { TERM_PROGRAM: 'iTerm.app' } })).toBe(false)
    expect(isWarpTerminal({ env: {} })).toBe(false)
  })
})
