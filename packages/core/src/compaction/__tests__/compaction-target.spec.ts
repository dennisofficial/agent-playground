import { describe, expect, it } from 'bun:test'

import { compactionTarget, ECompactionRefusal } from '../compaction-target'
import { called, compacted, denied, eventsFrom, replied, resulted, said } from './fixture'

describe('compactionTarget', () => {
  it('refuses a watermark past the end of the thread', () => {
    const events = eventsFrom([said('hello'), replied('hi')])

    expect(compactionTarget({ events, throughSeq: 9 })).toEqual({
      allowed: false,
      refusal: ECompactionRefusal.NoSuchTarget,
      reason: '9 is not a compaction target on a thread holding sequences 1 through 2',
    })
  })

  it('refuses a watermark below the first sequence the thread still holds', () => {
    const events = eventsFrom([said('hello'), replied('hi')])

    expect(compactionTarget({ events, throughSeq: 0 }).allowed).toBe(false)
  })

  it('allows a watermark that lands on a settled turn boundary', () => {
    const events = eventsFrom([
      said('clean the build'),
      replied('on it'),
      called('call-1'),
      resulted('call-1'),
      replied('done'),
      said('now run the tests'),
    ])

    expect(compactionTarget({ events, throughSeq: 5 })).toEqual({ allowed: true })
  })

  it('refuses a watermark that keeps a tool result whose call it compacts', () => {
    const events = eventsFrom([
      said('clean the build'),
      replied('on it'),
      called('call-1'),
      resulted('call-1'),
    ])

    expect(compactionTarget({ events, throughSeq: 3 })).toEqual({
      allowed: false,
      refusal: ECompactionRefusal.SplitsToolCall,
      reason: 'compacting through 3 would keep the result of bash (call-1) after compacting the call it answers',
    })
  })

  it('refuses the same split when the call was denied rather than run', () => {
    const events = eventsFrom([said('delete everything'), called('call-1'), denied('call-1')])

    const target = compactionTarget({ events, throughSeq: 2 })

    expect(target.allowed).toBe(false)
    expect(target.allowed === false && target.refusal).toBe(ECompactionRefusal.SplitsToolCall)
  })

  it('allows a watermark that compacts a call together with its result', () => {
    const events = eventsFrom([
      said('clean the build'),
      called('call-1'),
      resulted('call-1'),
      replied('done'),
    ])

    expect(compactionTarget({ events, throughSeq: 3 })).toEqual({ allowed: true })
  })

  it('allows a watermark over a call the turn never settled, which renders no result to orphan', () => {
    const events = eventsFrom([said('clean the build'), called('call-1'), said('never mind')])

    expect(compactionTarget({ events, throughSeq: 2 })).toEqual({ allowed: true })
  })

  it('refuses a watermark a previous compaction already covers', () => {
    const events = eventsFrom([said('hello'), replied('hi'), compacted(2, 'we said hello')])

    expect(compactionTarget({ events, throughSeq: 2 })).toEqual({
      allowed: false,
      refusal: ECompactionRefusal.AlreadyCompacted,
      reason: 'this thread is already compacted through 2',
    })
  })

  it('allows a later watermark on a thread that was compacted before', () => {
    const events = eventsFrom([
      said('hello'),
      replied('hi'),
      compacted(2, 'we said hello'),
      said('and now this'),
      replied('indeed'),
    ])

    expect(compactionTarget({ events, throughSeq: 5 })).toEqual({ allowed: true })
  })
})
