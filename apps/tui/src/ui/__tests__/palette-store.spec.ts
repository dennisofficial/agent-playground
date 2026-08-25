import { afterEach, describe, expect, it } from 'bun:test'

import {
  applyPalette,
  onPaletteChange,
  paletteVersion,
  resetPalette,
  subscribePalette,
} from '../palette-store'
import { SHIPPED_PALETTE, theme } from '../palette'

afterEach(() => {
  resetPalette()
})

describe('applyPalette', () => {
  it('mutates the live palette in place, so module-scope holders see the change', () => {
    const held = theme
    applyPalette({ accent: '#00ff00' })
    expect(held.accent).toBe('#00ff00')
    expect(held).toBe(theme)
  })

  it('moves one token without restating the rest', () => {
    applyPalette({ accent: '#00ff00' })
    expect(theme.dim).toBe(SHIPPED_PALETTE.dim)
  })

  it('bumps a numeric version, which is what useSyncExternalStore snapshots', () => {
    const before = paletteVersion()
    applyPalette({ accent: '#00ff00' })
    expect(paletteVersion()).toBe(before + 1)
  })

  it('drops caches before it repaints, so a repaint cannot read a stale colour', () => {
    const order: string[] = []
    onPaletteChange(() => order.push('invalidate'))
    const unsubscribe = subscribePalette(() => order.push('repaint'))

    applyPalette({ accent: '#00ff00' })
    unsubscribe()

    expect(order.indexOf('invalidate')).toBeLessThan(order.indexOf('repaint'))
  })

  it('stops calling a listener that unsubscribed', () => {
    let calls = 0
    const unsubscribe = subscribePalette(() => {
      calls += 1
    })
    unsubscribe()

    applyPalette({ accent: '#00ff00' })
    expect(calls).toBe(0)
  })
})

describe('resetPalette', () => {
  it('restores the shipped colours', () => {
    applyPalette({ accent: '#00ff00', dim: '#123456' })
    resetPalette()
    expect(theme.accent).toBe(SHIPPED_PALETTE.accent)
    expect(theme.dim).toBe(SHIPPED_PALETTE.dim)
  })

  it('clones on the way in, so the next edit cannot write into the defaults', () => {
    resetPalette()
    applyPalette({ accent: '#00ff00' })
    expect(SHIPPED_PALETTE.accent).not.toBe('#00ff00')
  })

  it('leaves nested groups restored too, not half from each theme', () => {
    applyPalette({ court: { agent: '#1', yours: '#2', external: '#3', none: '#4' } })
    resetPalette()
    expect(theme.court).toEqual(SHIPPED_PALETTE.court)
  })
})
