import { describe, expect, it } from 'bun:test'

import { ECompactionRefusal } from '../compaction-target'
import { suffixCompactionTarget } from '../suffix-target'
import { called, compacted, eventsFrom, replied, resulted, said } from './fixture'

describe('suffixCompactionTarget', () => {
  it('refuses a start the thread does not hold', () => {
    const events = eventsFrom([said('one'), replied('two')])

    expect(suffixCompactionTarget({ events, fromSeq: 9 })).toEqual({
      allowed: false,
      refusal: ECompactionRefusal.NoSuchTarget,
      reason: '9 is not a compaction target on a thread holding sequences 1 through 2',
    })
  })

  it('allows a start that summarises the tail and keeps the head', () => {
    const events = eventsFrom([said('one'), replied('two'), said('three'), replied('four')])

    expect(suffixCompactionTarget({ events, fromSeq: 3 })).toEqual({ allowed: true })
  })

  it('refuses a start that would leave a dispatched call behind with its result summarised away', () => {
    const events = eventsFrom([
      said('clean it'),
      called('call-1'),
      resulted('call-1'),
      replied('done'),
    ])

    expect(suffixCompactionTarget({ events, fromSeq: 3 })).toEqual({
      allowed: false,
      refusal: ECompactionRefusal.SplitsToolCall,
      reason:
        'summarising from 3 would leave bash (call-1) dispatched with its result summarised away, so the next turn would run it again',
    })
  })

  it('allows a start that takes a call and its result together', () => {
    const events = eventsFrom([
      said('clean it'),
      called('call-1'),
      resulted('call-1'),
      replied('done'),
    ])

    expect(suffixCompactionTarget({ events, fromSeq: 2 })).toEqual({ allowed: true })
  })

  it('refuses a start with nothing above it to summarise', () => {
    const events = eventsFrom([said('one'), replied('two')])

    expect(suffixCompactionTarget({ events, fromSeq: 2 })).toEqual({
      allowed: false,
      refusal: ECompactionRefusal.NothingToCompact,
      reason: 'summarising from 2 would replace one event with a summary of it, which saves nothing',
    })
  })

  it('refuses a start inside a range a prefix compaction already replaced', () => {
    const events = eventsFrom([compacted(3, 'the opening'), said('four'), replied('five')])

    expect(suffixCompactionTarget({ events, fromSeq: 2 })).toEqual({
      allowed: false,
      refusal: ECompactionRefusal.AlreadyCompacted,
      reason: 'this thread is already compacted through 3',
    })
  })
})
