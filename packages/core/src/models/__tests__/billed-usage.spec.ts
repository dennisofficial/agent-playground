import { describe, expect, it } from 'bun:test'

import type { ModelUsage } from '../../stream/chunk'
import { addUsage, contextTokens, NOTHING_BILLED } from '../usage'

const step = (usage: ModelUsage): ModelUsage => usage

describe('what a turn was billed, summed over its steps', () => {
  it('starts at nothing', () => {
    expect(NOTHING_BILLED).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
  })

  it('sums every step, because each one is billed the whole prompt it sent', () => {
    const first = addUsage({
      billed: NOTHING_BILLED,
      step: step({ inputTokens: 1_000, outputTokens: 50, cacheReadTokens: 800, cacheWriteTokens: 200 }),
    })
    const second = addUsage({
      billed: first,
      step: step({ inputTokens: 1_400, outputTokens: 30, cacheReadTokens: 1_000, cacheWriteTokens: 0 }),
    })

    expect(second).toEqual({
      inputTokens: 2_400,
      outputTokens: 80,
      cacheReadTokens: 1_800,
      cacheWriteTokens: 200,
    })
  })

  it('treats a step that reported no cache tiers as having read and written nothing', () => {
    expect(addUsage({ billed: NOTHING_BILLED, step: step({ inputTokens: 12, outputTokens: 3 }) })).toEqual({
      inputTokens: 12,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
  })

  it('leaves the tally alone when a step reported nothing at all', () => {
    const one = addUsage({ billed: NOTHING_BILLED, step: step({ inputTokens: 7, outputTokens: 2 }) })
    expect(addUsage({ billed: one, step: undefined })).toEqual(one)
  })

  it('refuses a negative count rather than crediting the turn', () => {
    expect(
      addUsage({
        billed: NOTHING_BILLED,
        step: step({ inputTokens: -5, outputTokens: 10, cacheReadTokens: -1 }),
      }),
    ).toEqual({ inputTokens: 0, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 })
  })
})

describe('the cache tiers are a breakdown of the prompt, not an addition to it', () => {
  it('leaves the context answer untouched when the tiers are reported', () => {
    const reported: ModelUsage = {
      inputTokens: 41_000,
      outputTokens: 900,
      cacheReadTokens: 39_000,
      cacheWriteTokens: 1_500,
    }

    expect(contextTokens({ reported, events: [] })).toBe(41_900)
  })
})
