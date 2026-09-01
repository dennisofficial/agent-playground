import { describe, expect, it } from 'bun:test'

import { formatElapsed } from '../theme'

describe('how an elapsed reading is written', () => {
  it('counts seconds alone under a minute', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(59_999)).toBe('59s')
  })

  it('carries seconds alongside minutes under an hour', () => {
    expect(formatElapsed(64_000)).toBe('1m 4s')
    expect(formatElapsed(3_599_000)).toBe('59m 59s')
  })

  /**
   * A background shell outlives a turn by orders of magnitude, so the reading has to roll over
   * rather than count a watched dev server into four-figure minutes.
   */
  it('rolls over to hours and drops the seconds, which stop mattering at that scale', () => {
    expect(formatElapsed(3_600_000)).toBe('1h 0m')
    expect(formatElapsed(9_000_000)).toBe('2h 30m')
  })
})
