import { describe, expect, it } from 'bun:test'

import { EEffort } from '../catalog'
import { EFFORT_ORDER, nextEffort, thinkingBudgetFor } from '../effort'

describe('EFFORT_ORDER', () => {
  it('runs from low to high', () => {
    expect(EFFORT_ORDER).toEqual([EEffort.Low, EEffort.Medium, EEffort.High])
  })
})

describe('thinkingBudgetFor', () => {
  it('spends more tokens the higher the effort', () => {
    const budgets = EFFORT_ORDER.map(thinkingBudgetFor)

    expect(budgets).toEqual([...budgets].sort((left, right) => left - right))
    expect(new Set(budgets).size).toBe(EFFORT_ORDER.length)
  })

  it('keeps the app default at medium', () => {
    expect(thinkingBudgetFor(EEffort.Medium)).toBe(2048)
  })

  it('never asks for less than the minimum extended-thinking budget', () => {
    for (const effort of EFFORT_ORDER) {
      expect(thinkingBudgetFor(effort)).toBeGreaterThanOrEqual(1024)
    }
  })
})

describe('nextEffort', () => {
  it('steps one notch up', () => {
    expect(nextEffort({ effort: EEffort.Low, delta: 1 })).toBe(EEffort.Medium)
  })

  it('steps one notch down', () => {
    expect(nextEffort({ effort: EEffort.High, delta: -1 })).toBe(EEffort.Medium)
  })

  it('stops at high instead of running off the end', () => {
    expect(nextEffort({ effort: EEffort.High, delta: 1 })).toBe(EEffort.High)
    expect(nextEffort({ effort: EEffort.Medium, delta: 5 })).toBe(EEffort.High)
  })

  it('stops at low instead of running off the start', () => {
    expect(nextEffort({ effort: EEffort.Low, delta: -1 })).toBe(EEffort.Low)
    expect(nextEffort({ effort: EEffort.High, delta: -9 })).toBe(EEffort.Low)
  })

  it('stays put when asked to move nowhere', () => {
    expect(nextEffort({ effort: EEffort.Medium, delta: 0 })).toBe(EEffort.Medium)
  })
})
