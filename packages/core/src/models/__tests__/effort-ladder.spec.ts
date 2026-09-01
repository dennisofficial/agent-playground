import { describe, expect, it } from 'bun:test'

import {
  clampEffort,
  EEffort,
  EFFORT_LADDER,
  nextEffort,
  supportedEfforts,
  type EffortMap,
} from '../effort-ladder'

const ANTHROPIC_ADAPTIVE: EffortMap = {
  [EEffort.Low]: 'low',
  [EEffort.Medium]: 'medium',
  [EEffort.High]: 'high',
  [EEffort.XHigh]: 'xhigh',
  [EEffort.Max]: 'max',
}

const OPENAI_RESPONSES: EffortMap = {
  [EEffort.Off]: 'none',
  [EEffort.Low]: 'low',
  [EEffort.Medium]: 'medium',
  [EEffort.High]: 'high',
}

describe('EFFORT_LADDER', () => {
  it('runs from off to max', () => {
    expect(EFFORT_LADDER).toEqual([
      EEffort.Off,
      EEffort.Minimal,
      EEffort.Low,
      EEffort.Medium,
      EEffort.High,
      EEffort.XHigh,
      EEffort.Max,
    ])
  })
})

describe('supportedEfforts', () => {
  it('offers only the rungs the model declares', () => {
    expect(supportedEfforts(ANTHROPIC_ADAPTIVE)).toEqual([
      EEffort.Low,
      EEffort.Medium,
      EEffort.High,
      EEffort.XHigh,
      EEffort.Max,
    ])
  })

  it('keeps the rungs in ladder order however the map was written', () => {
    expect(supportedEfforts(OPENAI_RESPONSES)).toEqual([
      EEffort.Off,
      EEffort.Low,
      EEffort.Medium,
      EEffort.High,
    ])
  })

  it('offers nothing for a model with no reasoning control', () => {
    expect(supportedEfforts(undefined)).toEqual([])
  })
})

describe('clampEffort', () => {
  it('keeps a rung the model actually has', () => {
    expect(clampEffort({ map: ANTHROPIC_ADAPTIVE, effort: EEffort.High })).toBe(EEffort.High)
  })

  it('reaches upward first, so a switch never quietly thinks less than asked', () => {
    const skipsXHigh: EffortMap = { [EEffort.High]: 'high', [EEffort.Max]: 'max' }

    expect(clampEffort({ map: skipsXHigh, effort: EEffort.XHigh })).toBe(EEffort.Max)
  })

  it('falls back down when the ladder has nothing above', () => {
    expect(clampEffort({ map: OPENAI_RESPONSES, effort: EEffort.Max })).toBe(EEffort.High)
  })

  it('has nothing to offer a model with no reasoning control', () => {
    expect(clampEffort({ map: undefined, effort: EEffort.High })).toBeUndefined()
  })
})

describe('nextEffort', () => {
  it('steps to the neighbouring rung the model has, not the neighbouring rung in the ladder', () => {
    const skipsXHigh: EffortMap = { [EEffort.High]: 'high', [EEffort.Max]: 'max' }

    expect(nextEffort({ map: skipsXHigh, effort: EEffort.High, delta: 1 })).toBe(EEffort.Max)
  })

  it('stops at each end rather than wrapping', () => {
    expect(nextEffort({ map: OPENAI_RESPONSES, effort: EEffort.High, delta: 1 })).toBe(EEffort.High)
    expect(nextEffort({ map: OPENAI_RESPONSES, effort: EEffort.Off, delta: -1 })).toBe(EEffort.Off)
  })

  it('lands on the model ladder first when the held rung is not on it', () => {
    expect(nextEffort({ map: OPENAI_RESPONSES, effort: EEffort.Max, delta: -1 })).toBe(
      EEffort.Medium,
    )
  })

  it('has nowhere to step on a model with no reasoning control', () => {
    expect(nextEffort({ map: undefined, effort: EEffort.High, delta: 1 })).toBeUndefined()
  })
})

describe('a budget-controlled model', () => {
  const HAIKU_BUDGET: EffortMap = {
    [EEffort.Low]: 1024,
    [EEffort.Medium]: 2048,
    [EEffort.High]: 16_384,
  }

  it('offers rungs like any other, so the picker cannot tell the dialects apart', () => {
    expect(supportedEfforts(HAIKU_BUDGET)).toEqual([EEffort.Low, EEffort.Medium, EEffort.High])
  })

  it('carries a token budget where an effort-controlled model carries a wire literal', () => {
    expect(HAIKU_BUDGET[EEffort.Medium]).toBe(2048)
    expect(ANTHROPIC_ADAPTIVE[EEffort.Medium]).toBe('medium')
  })
})
