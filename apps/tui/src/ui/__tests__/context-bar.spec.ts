import { describe, expect, it } from 'bun:test'

import {
  CONTEXT_BAR_CELLS,
  CONTEXT_WARN_PERCENT,
  contextBarCells,
  contextTone,
  isContextWarning,
} from '../context-bar'
import { theme } from '../theme'

const CELL_COUNTS = [1, 2, 3, 10] as const

describe('contextBarCells', () => {
  it('always spends exactly the cells it was given', () => {
    for (const cells of CELL_COUNTS) {
      for (let percent = 0; percent <= 100; percent += 1) {
        const bar = contextBarCells({ percent, cells })
        expect(bar.ok + bar.warn + bar.empty).toBe(cells)
      }
    }
  })

  it('never spends a negative cell', () => {
    for (const cells of CELL_COUNTS) {
      for (let percent = 0; percent <= 100; percent += 1) {
        const bar = contextBarCells({ percent, cells })
        expect(Math.min(bar.ok, bar.warn, bar.empty)).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('fills nothing at rest', () => {
    expect(contextBarCells({ percent: 0, cells: CONTEXT_BAR_CELLS })).toEqual({
      ok: 0,
      warn: 0,
      empty: CONTEXT_BAR_CELLS,
    })
  })

  it('lights a cell for a reading too small to round to one', () => {
    const bar = contextBarCells({ percent: 4, cells: 10 })
    expect(bar.ok).toBe(1)
    expect(bar.empty).toBe(9)
  })

  it('leaves nothing empty when the window is full', () => {
    const bar = contextBarCells({ percent: 100, cells: CONTEXT_BAR_CELLS })
    expect(bar.empty).toBe(0)
    expect(bar.ok + bar.warn).toBe(CONTEXT_BAR_CELLS)
  })

  it('holds the whole filled run comfortable up to the threshold', () => {
    for (let percent = 0; percent <= CONTEXT_WARN_PERCENT; percent += 1) {
      expect(contextBarCells({ percent, cells: CONTEXT_BAR_CELLS }).warn).toBe(0)
    }
  })

  it('bleeds into the warning band above the threshold', () => {
    const bar = contextBarCells({ percent: 96, cells: CONTEXT_BAR_CELLS })
    expect(bar.warn).toBeGreaterThan(0)
    expect(bar.ok).toBeGreaterThan(0)
  })

  it('clamps a reading outside the window', () => {
    expect(contextBarCells({ percent: -20, cells: 4 })).toEqual({ ok: 0, warn: 0, empty: 4 })
    expect(contextBarCells({ percent: 140, cells: 4 }).empty).toBe(0)
  })
})

describe('contextTone', () => {
  it('stays quiet below the threshold', () => {
    expect(contextTone(10)).toBe(theme.meta)
  })

  it('stays quiet at the threshold', () => {
    expect(contextTone(CONTEXT_WARN_PERCENT)).toBe(theme.meta)
    expect(isContextWarning(CONTEXT_WARN_PERCENT)).toBe(false)
  })

  it('warns above the threshold', () => {
    expect(contextTone(CONTEXT_WARN_PERCENT + 1)).toBe(theme.warn)
    expect(isContextWarning(CONTEXT_WARN_PERCENT + 1)).toBe(true)
  })
})
