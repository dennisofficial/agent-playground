import { describe, expect, it } from 'bun:test'

import { contextPressure } from '../pressure'

describe('contextPressure', () => {
  it('reports the share of the window in use', () => {
    expect(contextPressure({ used: 50_000, window: 200_000 })).toEqual({
      used: 50_000,
      window: 200_000,
      fraction: 0.25,
      percent: 25,
    })
  })

  it('rounds the percent to a whole number', () => {
    expect(contextPressure({ used: 1, window: 3 }).percent).toBe(33)
  })

  it('clamps a window that has been overrun', () => {
    const pressure = contextPressure({ used: 300_000, window: 200_000 })

    expect(pressure.fraction).toBe(1)
    expect(pressure.percent).toBe(100)
  })

  it('clamps a negative usage to nothing', () => {
    expect(contextPressure({ used: -10, window: 200_000 }).fraction).toBe(0)
  })

  it('reports no pressure when the window is unknown', () => {
    expect(contextPressure({ used: 1_000, window: 0 })).toEqual({
      used: 1_000,
      window: 0,
      fraction: 0,
      percent: 0,
    })
    expect(contextPressure({ used: 1_000, window: -5 }).fraction).toBe(0)
  })

  it('reports an empty conversation as no pressure', () => {
    expect(contextPressure({ used: 0, window: 200_000 }).percent).toBe(0)
  })
})
