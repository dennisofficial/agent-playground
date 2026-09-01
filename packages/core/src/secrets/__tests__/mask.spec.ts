import { describe, expect, it } from 'bun:test'

import { maskStoredSecret, maskTypedSecret } from '../mask'

describe('maskTypedSecret', () => {
  it('grows with the field so typing is visible', () => {
    expect(maskTypedSecret('')).toBe('')
    expect(maskTypedSecret('ab')).toBe('••')
    expect(maskTypedSecret('abcd')).toBe('••••')
    expect(maskTypedSecret('abcde')).toBe('•bcde')
    expect(maskTypedSecret('tvly-abcd1234')).toBe('•••••••••1234')
  })
})

describe('maskStoredSecret', () => {
  it('is a fixed width, so a long key does not stretch the row', () => {
    expect(maskStoredSecret('tvly-abcd1234')).toBe('••••1234')
    expect(maskStoredSecret('x'.repeat(200))).toBe('••••xxxx')
  })

  it('shows nothing of a secret too short to have a tail', () => {
    expect(maskStoredSecret('abcd')).toBe('••••')
    expect(maskStoredSecret('ab')).toBe('••••')
  })
})
