import { describe, expect, it } from 'bun:test'

import { contextTone, CONTEXT_WARN_PERCENT, isContextWarning } from '../context-bar'
import { theme } from '../theme'

describe('isContextWarning', () => {
  it('holds its peace up to the threshold and speaks past it', () => {
    expect(isContextWarning(CONTEXT_WARN_PERCENT)).toBe(false)
    expect(isContextWarning(CONTEXT_WARN_PERCENT + 1)).toBe(true)
  })
})

describe('contextTone', () => {
  it('stays quiet below the threshold', () => {
    expect(contextTone(10)).toBe(theme.meta)
  })

  it('stays quiet at the threshold', () => {
    expect(contextTone(CONTEXT_WARN_PERCENT)).toBe(theme.meta)
    expect(isContextWarning(CONTEXT_WARN_PERCENT)).toBe(false)
  })

  it('warns above the threshold', () => {
    expect(contextTone(CONTEXT_WARN_PERCENT + 1)).toBe(theme.warn)
    expect(isContextWarning(CONTEXT_WARN_PERCENT + 1)).toBe(true)
  })
})
