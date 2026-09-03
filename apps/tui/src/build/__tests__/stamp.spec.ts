import { describe, expect, it } from 'bun:test'

import { sourceStampOf } from '../stamp'

describe('sourceStampOf', () => {
  it('is stable over the same source state', () => {
    const state = { head: 'abc123', diff: 'diff --git a/x b/x\n+line\n' }

    expect(sourceStampOf(state)).toBe(sourceStampOf(state))
    expect(sourceStampOf(state)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('moves when the commit moves', () => {
    const diff = 'diff --git a/x b/x\n+line\n'

    expect(sourceStampOf({ head: 'abc123', diff })).not.toBe(sourceStampOf({ head: 'def456', diff }))
  })

  it('moves when uncommitted work moves, though the commit stands', () => {
    const head = 'abc123'

    expect(sourceStampOf({ head, diff: '' })).not.toBe(
      sourceStampOf({ head, diff: 'diff --git a/x b/x\n+line\n' }),
    )
  })
})
