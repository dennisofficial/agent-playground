import { afterEach, describe, expect, it } from 'bun:test'

import {
  applyFenceWrap,
  EFenceWrap,
  fenceWrap,
  fenceWrapOf,
  SHIPPED_FENCE_WRAP,
  wrapsFence,
} from '../fence-wrap-store'

afterEach(() => {
  applyFenceWrap(SHIPPED_FENCE_WRAP)
})

describe('fenceWrapOf', () => {
  it('reads the two narrowing spellings and defaults anything else to text', () => {
    expect(fenceWrapOf('never')).toBe(EFenceWrap.Never)
    expect(fenceWrapOf('all')).toBe(EFenceWrap.All)
    expect(fenceWrapOf('text')).toBe(EFenceWrap.Text)
    expect(fenceWrapOf('something-else')).toBe(EFenceWrap.Text)
  })
})

describe('wrapsFence', () => {
  it('wraps prose fences out of the box and leaves code alone', () => {
    expect(fenceWrap()).toBe(EFenceWrap.Text)
    expect(wrapsFence('md')).toBe(true)
    expect(wrapsFence('markdown')).toBe(true)
    expect(wrapsFence('txt')).toBe(true)
    expect(wrapsFence('text')).toBe(true)
    expect(wrapsFence('bash')).toBe(true)
    expect(wrapsFence('sh')).toBe(true)
    expect(wrapsFence('ts')).toBe(false)
    expect(wrapsFence('python')).toBe(false)
    expect(wrapsFence('')).toBe(false)
  })

  it('never wraps when told never', () => {
    applyFenceWrap(EFenceWrap.Never)
    expect(wrapsFence('md')).toBe(false)
    expect(wrapsFence('txt')).toBe(false)
  })

  it('wraps every fence when told all', () => {
    applyFenceWrap(EFenceWrap.All)
    expect(wrapsFence('ts')).toBe(true)
    expect(wrapsFence('diff')).toBe(true)
  })
})
