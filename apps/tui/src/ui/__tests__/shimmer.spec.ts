import { describe, expect, it } from 'bun:test'

import { beaconHeat, shimmerCrest, shimmerCycleMs, shimmerHeat, WORKING_SHIMMER } from '../shimmer'
import { mixHex } from '../colour'
import { shimmerSpans } from '../shimmer-style'

describe('the sweep arithmetic', () => {
  it('spends the quiet part of the cycle with the crest off the end of the line', () => {
    const cells = 40
    const cycle = shimmerCycleMs({ cells, spec: WORKING_SHIMMER })
    const resting = shimmerCrest({ nowMs: cycle - 1, cells, spec: WORKING_SHIMMER })
    expect(resting).toBeGreaterThan(cells + WORKING_SHIMMER.crestWidth)
  })

  it('never puts the crest behind the line, whatever the clock says', () => {
    for (const now of [0, -1, -100_000, 1_700_000_000_000]) {
      expect(
        shimmerCrest({ nowMs: now, cells: 40, spec: WORKING_SHIMMER }),
      ).toBeGreaterThanOrEqual(0)
    }
  })

  it('is fully lit under the crest and dark a crest-width away', () => {
    expect(shimmerHeat({ index: 10, crest: 10, spec: WORKING_SHIMMER })).toBe(1)
    expect(
      shimmerHeat({ index: 10 + WORKING_SHIMMER.crestWidth, crest: 10, spec: WORKING_SHIMMER }),
    ).toBe(0)
    expect(shimmerHeat({ index: 0, crest: 40, spec: WORKING_SHIMMER })).toBe(0)
  })

  it('flares the beacon only on the outbound crest', () => {
    expect(beaconHeat({ crest: 0, spec: WORKING_SHIMMER })).toBe(1)
    expect(beaconHeat({ crest: WORKING_SHIMMER.crestWidth * 2, spec: WORKING_SHIMMER })).toBe(0)
    expect(beaconHeat({ crest: 100, spec: WORKING_SHIMMER })).toBe(0)
  })
})

describe('the sweep, coloured', () => {
  it('clamps a blend rather than wrapping it', () => {
    expect(mixHex({ from: '#000000', to: '#ffffff', amount: -1 })).toBe('#000000')
    expect(mixHex({ from: '#000000', to: '#ffffff', amount: 2 })).toBe('#ffffff')
    expect(mixHex({ from: '#000000', to: '#ffffff', amount: 0.5 })).toBe('#808080')
  })

  it('coalesces runs of one colour, so a resting line is a handful of spans', () => {
    const label = 'Thinking for 12s (esc to interrupt)'
    const spans = shimmerSpans({ text: label, crest: 4, spec: WORKING_SHIMMER, offset: 2 })
    expect(spans.length).toBeLessThan([...label].length)
    expect(spans.map((span) => span.text).join('')).toBe(label)
  })

  it('measures in code points, so a one-column glyph counts as one cell', () => {
    const spans = shimmerSpans({ text: '↓ 12k tokens · esc', crest: 0, spec: WORKING_SHIMMER })
    expect(spans.map((span) => span.text).join('')).toBe('↓ 12k tokens · esc')
  })
})
