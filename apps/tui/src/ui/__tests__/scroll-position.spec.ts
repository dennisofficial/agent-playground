import { describe, expect, it } from 'bun:test'

import { isPinnedToBottom } from '../scroll-position'

describe('whether the transcript is at the bottom', () => {
  it('is pinned when the scroll is at the end', () => {
    expect(isPinnedToBottom({ scrollTop: 80, scrollHeight: 100, viewportHeight: 20 })).toBe(true)
  })

  it('is not pinned a single row up', () => {
    expect(isPinnedToBottom({ scrollTop: 79, scrollHeight: 100, viewportHeight: 20 })).toBe(false)
  })

  it('is pinned when the content is shorter than the viewport', () => {
    expect(isPinnedToBottom({ scrollTop: 0, scrollHeight: 5, viewportHeight: 20 })).toBe(true)
  })

  it('is pinned when the scroll has overshot, which a reflow can do', () => {
    expect(isPinnedToBottom({ scrollTop: 200, scrollHeight: 100, viewportHeight: 20 })).toBe(true)
  })
})
