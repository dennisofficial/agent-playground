import { describe, expect, it } from 'bun:test'

import type { EventDraft } from '../../events/body'
import { planCompaction } from '../compaction-plan'
import { called, compacted, eventsFrom, replied, resulted, said } from './fixture'

const HUNDRED_TOKENS = 'x'.repeat(400)

const turn = (): readonly EventDraft[] => [said(HUNDRED_TOKENS), replied(HUNDRED_TOKENS)]

const turns = (count: number): readonly EventDraft[] =>
  Array.from({ length: count }, turn).flat()

describe('planCompaction', () => {
  it('proposes nothing for a thread that already fits the recency budget', () => {
    const events = eventsFrom(turns(2))

    expect(planCompaction({ events, keepRecentTokens: 1000 })).toBeUndefined()
  })

  it('proposes the deepest watermark that still leaves the recency budget intact', () => {
    const events = eventsFrom(turns(6))

    expect(planCompaction({ events, keepRecentTokens: 250 })).toEqual({
      throughSeq: 8,
      compactedEvents: 8,
      keptEvents: 4,
    })
  })

  it('never bisects a turn, so the watermark always sits just before an operator message', () => {
    const events = eventsFrom(turns(8))
    const plan = planCompaction({ events, keepRecentTokens: 350 })

    const nextEvent = events.find((event) => event.seq === (plan?.throughSeq ?? 0) + 1)
    expect(nextEvent?.type).toBe('user-said')
  })

  it('proposes nothing when the only untouched turn is the one in progress', () => {
    const events = eventsFrom(turns(1))

    expect(planCompaction({ events, keepRecentTokens: 10 })).toBeUndefined()
  })

  it('advances past a watermark the thread already carries', () => {
    const events = eventsFrom([...turns(3), compacted(2, 'the first turn'), ...turns(3)])
    const plan = planCompaction({ events, keepRecentTokens: 250 })

    expect(plan?.throughSeq).toBeGreaterThan(2)
  })

  it('refuses to propose a watermark the guard would reject', () => {
    const events = eventsFrom([
      said(HUNDRED_TOKENS),
      called('call-1'),
      said(HUNDRED_TOKENS),
      resulted('call-1'),
      replied(HUNDRED_TOKENS),
      said(HUNDRED_TOKENS),
      replied(HUNDRED_TOKENS),
    ])

    expect(planCompaction({ events, keepRecentTokens: 250 })?.throughSeq).not.toBe(2)
  })
})
