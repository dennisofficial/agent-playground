import { afterEach, describe, expect, it } from 'bun:test'

import { accentHex, accentPalette } from '../accents'
import { ACCENT, SHIPPED_PALETTE, theme } from '../palette'
import { applyPalette, resetPalette } from '../palette-store'

afterEach(() => {
  resetPalette()
})

describe('the accent a chosen palette carries', () => {
  it('reads an accent Atlas does not know as the shipped one', () => {
    expect(accentHex('vermilion')).toBe(ACCENT)
    expect(accentHex('moss')).not.toBe(ACCENT)
  })

  it('puts the operator on the accent, so a sent message rails in the app colour', () => {
    expect(SHIPPED_PALETTE.court.yours).toBe(SHIPPED_PALETTE.accent)

    applyPalette(accentPalette('moss'))

    expect(theme.court.yours).toBe(accentHex('moss'))
    expect(theme.court.yours).toBe(theme.accent)
  })

  it('leaves the colours that carry a meaning of their own where they were', () => {
    applyPalette(accentPalette('plum'))

    expect(theme.court.external).toBe(SHIPPED_PALETTE.court.external)
    expect(theme.warn).toBe(SHIPPED_PALETTE.warn)
    expect(theme.error).toBe(SHIPPED_PALETTE.error)
  })
})
