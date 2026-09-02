import { describe, expect, it } from 'bun:test'

import {
  EClassifierMode,
  EDecision,
  EJudgment,
  ERiskDimension,
  ETriage,
  stampDrafts,
  toCallId,
  toEventId,
  toRunId,
  toThreadId,
  type Event,
  type EventDraft,
} from '@dltech/atlas-core'

import {
  answerDrafts,
  APPROVAL_OPTIONS,
  decisionOf,
  EApprovalChoice,
  moveSelection,
  openApproval,
  resolve,
  selectedOption,
  unansweredApproval,
} from '../approval-model'

const CALL = toCallId('call-1')

const REASON = 'this would remove a worktree another session is standing in'

const opened = openApproval({ callId: CALL, reason: REASON })

const log = (drafts: readonly EventDraft[]): Event[] =>
  stampDrafts({
    drafts,
    envelopes: drafts.map((_draft, index) => ({
      id: toEventId(`event-${index + 1}`),
      seq: index + 1,
      threadId: toThreadId('thread-approval'),
      runId: toRunId('run-approval'),
      depth: 0,
      at: '2026-01-01T00:00:00.000Z',
    })),
  })

const asked: EventDraft = { type: 'approval-requested', callId: CALL, reason: REASON }

describe('the approval drawer', () => {
  it('opens on the question the operator was asked, offering to proceed first', () => {
    expect(opened).toEqual({
      callId: CALL,
      reason: REASON,
      evidence: [],
      dimensions: [],
      grantables: [],
      selected: 0,
    })
    expect(selectedOption(opened)?.choice).toBe(EApprovalChoice.Proceed)
  })

  it('moves down to the refusal and back up again', () => {
    const down = moveSelection({ state: opened, delta: 1 })
    expect(resolve(down)).toBe(EApprovalChoice.Decline)

    expect(resolve(moveSelection({ state: down, delta: -1 }))).toBe(EApprovalChoice.Proceed)
  })

  it('stops at the ends rather than wrapping, so a held key cannot flip the answer', () => {
    const bottom = moveSelection({ state: opened, delta: 5 })
    expect(bottom.selected).toBe(APPROVAL_OPTIONS.length - 1)
    expect(moveSelection({ state: bottom, delta: 1 })).toBe(bottom)

    const top = moveSelection({ state: bottom, delta: -5 })
    expect(top.selected).toBe(0)
    expect(moveSelection({ state: top, delta: -1 })).toBe(top)
  })

  it('keeps the call it is asking about while the selection moves', () => {
    expect(moveSelection({ state: opened, delta: 1 }).callId).toBe(CALL)
    expect(moveSelection({ state: opened, delta: 1 }).reason).toBe(REASON)
  })

  it('answers the call rather than a decision detached from it', () => {
    expect(answerDrafts({ callId: CALL, choice: EApprovalChoice.Proceed })).toEqual([
      { type: 'approval-answered', callId: CALL, decision: EDecision.Allow },
    ])
    expect(answerDrafts({ callId: CALL, choice: EApprovalChoice.Decline })).toEqual([
      { type: 'approval-answered', callId: CALL, decision: EDecision.Deny },
    ])
  })

  it('reads decline as a denial, which is what the dispatcher acts on', () => {
    expect(decisionOf(EApprovalChoice.Decline)).toBe(EDecision.Deny)
    expect(decisionOf(EApprovalChoice.Proceed)).toBe(EDecision.Allow)
  })
})

describe('finding the question a pause stopped on', () => {
  it('reads the unanswered request off the log', () => {
    expect(unansweredApproval({ events: log([asked]), callId: CALL })).toEqual({
      callId: CALL,
      reason: REASON,
      evidence: [],
      dimensions: [],
      grantables: [],
    })
  })

  it('finds nothing once the operator has answered', () => {
    const events = log([asked, { type: 'approval-answered', callId: CALL, decision: EDecision.Allow }])

    expect(unansweredApproval({ events, callId: CALL })).toBeNull()
  })

  it('finds nothing for a pause no question explains, so the driver still reports it', () => {
    expect(unansweredApproval({ events: log([asked]), callId: toCallId('call-2') })).toBeNull()
  })

  it('takes the latest question when a call was asked about twice', () => {
    const events = log([
      asked,
      { type: 'approval-requested', callId: CALL, reason: 'and now for a second reason' },
    ])

    expect(unansweredApproval({ events, callId: CALL })?.reason).toBe('and now for a second reason')
  })
})

const weighed: EventDraft = {
  type: 'classifier-judged',
  callId: CALL,
  mode: EClassifierMode.Nudge,
  triage: ETriage.Consult,
  judgment: EJudgment.Check,
  dimensions: [ERiskDimension.Contention, ERiskDimension.Irreversibility],
  judgedDimension: ERiskDimension.Contention,
  signalIds: ['contention:occupied'],
  details: [
    'eng-412-sidebar is held by another live session',
    'the worktree carries twelve uncommitted changes',
  ],
  reason: REASON,
  consulted: true,
  wouldAsk: true,
  fatigued: false,
  elapsedMs: 610,
}

describe('the evidence behind a pause', () => {
  it('carries the surviving probes own words and the dimensions they belong to', () => {
    const question = unansweredApproval({ events: log([weighed, asked]), callId: CALL })

    expect(question?.evidence).toEqual([
      'eng-412-sidebar is held by another live session',
      'the worktree carries twelve uncommitted changes',
    ])
    expect(question?.dimensions).toEqual([
      ERiskDimension.Contention,
      ERiskDimension.Irreversibility,
    ])
  })

  it('opens the drawer on that evidence rather than on the reason alone', () => {
    const question = unansweredApproval({ events: log([weighed, asked]), callId: CALL })
    if (question === null) throw new Error('the pause carried no question')

    expect(openApproval(question).evidence).toHaveLength(2)
    expect(resolve(openApproval(question))).toBe(EApprovalChoice.Proceed)
  })

  it('ignores a weighing of some other call', () => {
    const other = { ...weighed, callId: toCallId('call-2') }
    const question = unansweredApproval({ events: log([other, asked]), callId: CALL })

    expect(question?.evidence).toEqual([])
  })

  it('still opens on a pause no classifier row explains', () => {
    expect(unansweredApproval({ events: log([asked]), callId: CALL })?.evidence).toEqual([])
  })
})
