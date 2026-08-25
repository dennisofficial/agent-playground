import { describe, expect, it } from 'bun:test'

import { beaconHeat, shimmerCrest, shimmerCycleMs, shimmerHeat, WORKING_SHIMMER } from '../shimmer'
import { mixHex, shimmerSpans } from '../shimmer-style'

describe('the sweep arithmetic', () => {
  it('spends the quiet part of the cycle with the crest off the end of the line', () => {
    const cells = 40
    const cycle = shimmerCycleMs(cells, WORKING_SHIMMER)
    const resting = shimmerCrest(cycle - 1, cells, WORKING_SHIMMER)
    expect(resting).toBeGreaterThan(cells + WORKING_SHIMMER.crestWidth)
  })

  it('never puts the crest behind the line, whatever the clock says', () => {
    for (const now of [0, -1, -100_000, 1_700_000_000_000]) {
      expect(shimmerCrest(now, 40, WORKING_SHIMMER)).toBeGreaterThanOrEqual(0)
    }
  })

  it('is fully lit under the crest and dark a crest-width away', () => {
    expect(shimmerHeat(10, 10, WORKING_SHIMMER)).toBe(1)
    expect(shimmerHeat(10 + WORKING_SHIMMER.crestWidth, 10, WORKING_SHIMMER)).toBe(0)
    expect(shimmerHeat(0, 40, WORKING_SHIMMER)).toBe(0)
  })

  it('flares the beacon only on the outbound crest', () => {
    expect(beaconHeat(0, WORKING_SHIMMER)).toBe(1)
    expect(beaconHeat(WORKING_SHIMMER.crestWidth * 2, WORKING_SHIMMER)).toBe(0)
    expect(beaconHeat(100, WORKING_SHIMMER)).toBe(0)
  })
})

describe('the sweep, coloured', () => {
  it('clamps a blend rather than wrapping it', () => {
    expect(mixHex('#000000', '#ffffff', -1)).toBe('#000000')
    expect(mixHex('#000000', '#ffffff', 2)).toBe('#ffffff')
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080')
  })

  it('coalesces runs of one colour, so a resting line is a handful of spans', () => {
    const label = 'Working for 12s (esc to interrupt)'
    const spans = shimmerSpans(label, 4, WORKING_SHIMMER, 2)
    expect(spans.length).toBeLessThan([...label].length)
    expect(spans.map((span) => span.text).join('')).toBe(label)
  })

  it('measures in code points, so a one-column glyph counts as one cell', () => {
    const spans = shimmerSpans('↓ 12k tokens · esc', 0, WORKING_SHIMMER)
    expect(spans.map((span) => span.text).join('')).toBe('↓ 12k tokens · esc')
  })
})
