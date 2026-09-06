import {
  EClassifierMode,
  ERiskDimension,
  ETriage,
  EJudgment,
  toCallId,
  type EventDraft,
} from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import { IDLE_TURN } from '../../ui/turn-clock'
import { deriveSidebar } from '../sidebar-model'
import { classifierFold } from '../classifier-fold'
import { log } from './fixture'

let minted = 0

const weighed = (over: Partial<EventDraft & { type: 'classifier-judged' }>): EventDraft => {
  minted += 1

  return {
    type: 'classifier-judged',
    callId: toCallId(`call-${String(minted)}`),
    mode: EClassifierMode.Shadow,
    triage: ETriage.Consult,
    judgment: EJudgment.Proceed,
    dimensions: [ERiskDimension.Contention],
    signalIds: ['contention:occupied'],
    details: ['a sibling worktree is held by another session'],
    reason: 'a probe fired',
    consulted: true,
    wouldAsk: false,
    fatigued: false,
    elapsedMs: 500,
    ...over,
  }
}

const said = (text: string): EventDraft => ({ type: 'user-said', text })

const foldOf = (drafts: readonly EventDraft[]) => classifierFold({ events: log([...drafts]) })

describe('the pauses-per-turn figure', () => {
  it('is absent until the classifier has weighed anything at all', () => {
    expect(foldOf([said('go')])).toBeNull()
    expect(deriveSidebar({ events: log([said('go')]), turn: IDLE_TURN }).classifier).toBeUndefined()
  })

  it('counts the pauses it would have caused against the turns it watched', () => {
    const fold = foldOf([
      said('one'),
      weighed({ wouldAsk: true }),
      weighed({ wouldAsk: false }),
      said('two'),
      weighed({ wouldAsk: true }),
      said('three'),
      weighed({ wouldAsk: false }),
    ])

    expect(fold?.pauses).toBe(2)
    expect(fold?.turns).toBe(3)
  })

  it('counts what shadow would have done, which is the point of running it', () => {
    const fold = foldOf([said('one'), weighed({ mode: EClassifierMode.Shadow, wouldAsk: true })])

    expect(fold?.pauses).toBe(1)
  })

  it('names the dimension the judge cited most often across the pauses', () => {
    const fold = foldOf([
      said('one'),
      weighed({ wouldAsk: true, judgedDimension: ERiskDimension.Contention }),
      weighed({ wouldAsk: true, judgedDimension: ERiskDimension.Irreversibility }),
      weighed({ wouldAsk: true, judgedDimension: ERiskDimension.Irreversibility }),
      weighed({ wouldAsk: false, judgedDimension: ERiskDimension.Reach }),
    ])

    expect(fold?.topDimension).toBe(ERiskDimension.Irreversibility)
  })

  it('falls back to the standing dimensions when no judge named one', () => {
    const fold = foldOf([
      said('one'),
      weighed({ wouldAsk: true, dimensions: [ERiskDimension.Reach, ERiskDimension.Blast] }),
      weighed({ wouldAsk: true, dimensions: [ERiskDimension.Blast] }),
    ])

    expect(fold?.topDimension).toBe(ERiskDimension.Blast)
  })

  it('names no dimension when nothing ever paused', () => {
    expect(foldOf([said('one'), weighed({})])?.topDimension).toBeNull()
  })

  it('counts the calls that went by because the thread had spent its asks', () => {
    const fold = foldOf([
      said('one'),
      weighed({ triage: ETriage.Clear, fatigued: true }),
      weighed({ triage: ETriage.Clear, fatigued: true }),
      weighed({}),
    ])

    expect(fold?.quietedCalls).toBe(2)
  })
})

describe('the offline reading', () => {
  it('reports the judge unreachable when this turn consulted and got nothing back', () => {
    const fold = foldOf([said('one'), weighed({ triage: ETriage.Consult, consulted: false })])

    expect(fold?.judgeUnreachable).toBe(true)
  })

  it('stays quiet when every consultation this turn came back', () => {
    expect(foldOf([said('one'), weighed({ consulted: true })])?.judgeUnreachable).toBe(false)
  })

  it('does not report a call that never reached the judge as a failure to reach it', () => {
    const fold = foldOf([said('one'), weighed({ triage: ETriage.Clear, consulted: false })])

    expect(fold?.judgeUnreachable).toBe(false)
  })

  it('forgets last turns outage once the operator has spoken again', () => {
    const fold = foldOf([
      said('one'),
      weighed({ triage: ETriage.Consult, consulted: false }),
      said('two'),
      weighed({ consulted: true }),
    ])

    expect(fold?.judgeUnreachable).toBe(false)
  })
})
