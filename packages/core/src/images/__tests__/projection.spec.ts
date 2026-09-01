import { describe, expect, test } from 'bun:test'

import { EImageTier, patchTokens, projectedSize, projectedTokens, TIER_LIMITS } from '../projection'

const std = EImageTier.Standard
const hi = EImageTier.HighResolution

describe('patchTokens', () => {
  test('counts 28-pixel patches', () => {
    expect(patchTokens({ width: 280, height: 280 })).toBe(100)
  })

  test('pads a partial patch up to a whole one', () => {
    expect(patchTokens({ width: 281, height: 280 })).toBe(110)
  })
})

describe('projectedSize against the published table', () => {
  const rows = [
    { size: { width: 200, height: 200 }, standard: 64, high: 64 },
    { size: { width: 1000, height: 1000 }, standard: 1296, high: 1296 },
    { size: { width: 1092, height: 1092 }, standard: 1521, high: 1521 },
    { size: { width: 1920, height: 1080 }, standard: 1560, high: 2691 },
    { size: { width: 2000, height: 1500 }, standard: 1564, high: 3888 },
    { size: { width: 3840, height: 2160 }, standard: 1560, high: 4784 },
  ]

  for (const row of rows) {
    const label = `${row.size.width}x${row.size.height}`

    test(`${label} costs ${row.standard} on the standard tier`, () => {
      expect(projectedTokens({ size: row.size, tier: std })).toBe(row.standard)
    })

    test(`${label} costs ${row.high} on the high-resolution tier`, () => {
      expect(projectedTokens({ size: row.size, tier: hi })).toBe(row.high)
    })
  }
})

describe('projectedSize', () => {
  test('reproduces the documented A4 scan, which the edge limit alone would miss', () => {
    expect(projectedSize({ size: { width: 1075, height: 1520 }, tier: std })).toEqual({
      width: 924,
      height: 1307,
    })
  })

  test('resizes an image whose every edge is already inside the edge limit', () => {
    const scan = { width: 1075, height: 1520 }

    expect(scan.width).toBeLessThan(TIER_LIMITS[std].maxEdge)
    expect(scan.height).toBeLessThan(TIER_LIMITS[std].maxEdge)
    expect(projectedSize({ size: scan, tier: std })).not.toEqual(scan)
  })

  test('leaves that same scan alone on the high-resolution tier', () => {
    const scan = { width: 1075, height: 1520 }

    expect(projectedSize({ size: scan, tier: hi })).toEqual(scan)
  })

  test('a 16:9 screenshot lands short of the edge limit, not on it', () => {
    expect(projectedSize({ size: { width: 1920, height: 1080 }, tier: std })).toEqual({
      width: 1456,
      height: 819,
    })
  })

  test('never exceeds either limit of the tier it was given', () => {
    const sizes = [
      { width: 6000, height: 4000 },
      { width: 2576, height: 1673 },
      { width: 3024, height: 1964 },
      { width: 900, height: 4000 },
      { width: 8000, height: 120 },
    ]

    for (const tier of [std, hi]) {
      const limits = TIER_LIMITS[tier]

      for (const size of sizes) {
        const projected = projectedSize({ size, tier })

        expect(Math.max(projected.width, projected.height)).toBeLessThanOrEqual(limits.maxEdge)
        expect(patchTokens(projected)).toBeLessThanOrEqual(limits.maxVisualTokens)
      }
    }
  })

  test('preserves aspect ratio within a patch of the original', () => {
    const size = { width: 6000, height: 4000 }
    const projected = projectedSize({ size, tier: hi })

    expect(projected.width / projected.height).toBeCloseTo(size.width / size.height, 2)
  })

  test('handles a portrait image by projecting its rotation', () => {
    const landscape = projectedSize({ size: { width: 4000, height: 6000 }, tier: hi })
    const portrait = projectedSize({ size: { width: 6000, height: 4000 }, tier: hi })

    expect(landscape).toEqual({ width: portrait.height, height: portrait.width })
  })

  test('is idempotent, so an already-projected size is left alone', () => {
    const once = projectedSize({ size: { width: 6000, height: 4000 }, tier: hi })

    expect(projectedSize({ size: once, tier: hi })).toEqual(once)
  })

  test('defaults to the standard tier, which every model accepts', () => {
    const size = { width: 3840, height: 2160 }

    expect(projectedSize({ size })).toEqual(projectedSize({ size, tier: std }))
  })

  test('costs more on the high-resolution tier than on the standard one', () => {
    const size = { width: 3024, height: 1964 }

    expect(projectedTokens({ size, tier: hi })).toBeGreaterThan(
      projectedTokens({ size, tier: std }),
    )
  })
})
