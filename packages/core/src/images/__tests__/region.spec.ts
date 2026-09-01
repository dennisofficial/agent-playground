import { describe, expect, test } from 'bun:test'

import { EImageTier } from '../projection'
import { planRegion, regionSaving } from '../region'

const SCREENSHOT = { width: 2576, height: 1673 }

describe('planRegion', () => {
  test('passes a region that already sits inside the picture', () => {
    const plan = planRegion({ size: SCREENSHOT, region: { x: 0, y: 0, width: 1288, height: 836 } })

    expect(plan).toEqual({
      ok: true,
      region: { x: 0, y: 0, width: 1288, height: 836 },
      clamped: false,
    })
  })

  test('trims a region that runs off the edge rather than refusing it', () => {
    const plan = planRegion({
      size: SCREENSHOT,
      region: { x: 2000, y: 1500, width: 900, height: 900 },
    })

    expect(plan).toEqual({
      ok: true,
      region: { x: 2000, y: 1500, width: 576, height: 173 },
      clamped: true,
    })
  })

  test('refuses an origin past the right edge, which is a mistake and not a trim', () => {
    const plan = planRegion({ size: SCREENSHOT, region: { x: 2576, y: 0, width: 10, height: 10 } })

    expect(plan.ok).toBe(false)
    expect(plan.ok === false && plan.reason).toContain('past the right edge')
  })

  test('refuses an origin past the bottom edge', () => {
    const plan = planRegion({ size: SCREENSHOT, region: { x: 0, y: 1673, width: 10, height: 10 } })

    expect(plan.ok).toBe(false)
    expect(plan.ok === false && plan.reason).toContain('past the bottom edge')
  })

  test('keeps the last pixel readable, so a region at the far corner is one pixel wide', () => {
    const plan = planRegion({
      size: SCREENSHOT,
      region: { x: 2575, y: 1672, width: 50, height: 50 },
    })

    expect(plan).toEqual({
      ok: true,
      region: { x: 2575, y: 1672, width: 1, height: 1 },
      clamped: true,
    })
  })
})

describe('regionSaving', () => {
  test('a quarter of a screenshot costs a quarter of the patches', () => {
    const saving = regionSaving({
      size: SCREENSHOT,
      region: { width: 1288, height: 836 },
      tier: EImageTier.HighResolution,
    })

    expect(saving.cropped).toBeLessThan(saving.whole)
    expect(saving.saved).toBe(saving.whole - saving.cropped)
  })

  test('a pane sent whole is cheaper than the frame it came from, which is the point', () => {
    const saving = regionSaving({
      size: { width: 3024, height: 1964 },
      region: { width: 1512, height: 982 },
      tier: EImageTier.HighResolution,
    })

    expect(saving.whole).toBe(4760)
    expect(saving.cropped).toBe(1944)
  })

  test('reports no saving when the region is the whole picture', () => {
    const saving = regionSaving({ size: SCREENSHOT, region: SCREENSHOT })

    expect(saving.saved).toBe(0)
  })

  test('a crop of a picture the API would have downscaled beats it twice over', () => {
    const saving = regionSaving({
      size: { width: 6000, height: 4000 },
      region: { width: 1000, height: 800 },
      tier: EImageTier.HighResolution,
    })

    expect(saving.whole).toBe(4704)
    expect(saving.cropped).toBe(1044)
  })
})
