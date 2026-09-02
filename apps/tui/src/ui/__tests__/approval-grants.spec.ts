import { describe, expect, it } from 'bun:test'

import {
  EClassifierMode,
  EDecision,
  EGrantScope,
  EJudgment,
  ERiskDimension,
  ETriage,
  eventBodySchema,
  stampDrafts,
  toCallId,
  toEventId,
  toRunId,
  toThreadId,
  type Event,
  type EventDraft,
  type GrantOffer,
} from '@dltech/atlas-core'

import {
  answerDrafts,
  EApprovalChoice,
  grantIdFor,
  moveSelection,
  offersToStopAsking,
  openApproval,
  optionsFor,
  resolve,
  unansweredApproval,
} from '../approval-model'

const CALL = toCallId('call-1')

const REASON = 'contention: eng-412-sidebar is held by another live session'

const OFFERS: readonly GrantOffer[] = [
  { subject: 'worktree:eng-412-sidebar', dimensions: [ERiskDimension.Contention] },
  {
    subject: 'path:/Users/dennis/Developer/atlas/node_modules',
    dimensions: [ERiskDimension.Irreversibility, ERiskDimension.Blast],
  },
]

const offered = openApproval({ callId: CALL, reason: REASON, grantables: OFFERS })

const unwaivable = openApproval({ callId: CALL, reason: REASON, grantables: [] })

const log = (drafts: readonly EventDraft[]): Event[] =>
  stampDrafts({
    drafts,
    envelopes: drafts.map((_draft, index) => ({
      id: toEventId(`event-${String(index + 1)}`),
      seq: index + 1,
      threadId: toThreadId('thread-grants'),
      runId: toRunId('run-grants'),
      depth: 0,
      at: '2026-01-01T00:00:00.000Z',
    })),
  })

const judged = (grantables: readonly GrantOffer[] | undefined): EventDraft => ({
  type: 'classifier-judged',
  callId: CALL,
  mode: EClassifierMode.Nudge,
  triage: ETriage.Consult,
  judgment: EJudgment.Check,
  dimensions: [ERiskDimension.Contention],
  signalIds: ['contention:live-worktree'],
  details: ['eng-412-sidebar is held by another live session'],
  reason: REASON,
  consulted: true,
  wouldAsk: true,
  fatigued: false,
  elapsedMs: 610,
  ...(grantables === undefined ? {} : { grantables }),
})

const asked: EventDraft = { type: 'approval-requested', callId: CALL, reason: REASON }

describe('the third choice', () => {
  it('sits between proceeding once and declining, so Enter still proceeds once', () => {
    expect(optionsFor(offered).map((option) => option.choice)).toEqual([
      EApprovalChoice.Proceed,
      EApprovalChoice.Always,
      EApprovalChoice.Decline,
    ])
    expect(resolve(offered)).toBe(EApprovalChoice.Proceed)
  })

  it('names the subjects it would stop asking about rather than saying "this"', () => {
    const label = optionsFor(offered)
      .map((option) => option.label)
      .join(' | ')

    expect(label).toContain('worktree:eng-412-sidebar')
    expect(label).toContain('path:/Users/dennis/Developer/atlas/node_modules')
  })

  it('is absent entirely when nothing surviving the triage can be waived', () => {
    expect(optionsFor(unwaivable).map((option) => option.choice)).toEqual([
      EApprovalChoice.Proceed,
      EApprovalChoice.Decline,
    ])
    expect(offersToStopAsking(unwaivable)).toBe(false)
  })

  it('cannot be reached by holding the arrow key when it is absent', () => {
    expect(resolve(moveSelection({ state: unwaivable, delta: 9 }))).toBe(EApprovalChoice.Decline)
    expect(resolve(moveSelection({ state: offered, delta: 9 }))).toBe(EApprovalChoice.Decline)
    expect(resolve(moveSelection({ state: offered, delta: 1 }))).toBe(EApprovalChoice.Always)
  })
})

describe('the drafts the third choice mints', () => {
  const drafts = answerDrafts({
    callId: CALL,
    choice: EApprovalChoice.Always,
    grantables: OFFERS,
    reason: REASON,
  })

  it('allows the call and grants one permission per subject, in the same append', () => {
    expect(drafts).toEqual([
      { type: 'approval-answered', callId: CALL, decision: EDecision.Allow },
      {
        type: 'permission-granted',
        grantId: grantIdFor({ callId: CALL, subject: 'worktree:eng-412-sidebar' }),
        dimensions: [ERiskDimension.Contention],
        scope: EGrantScope.Thread,
        subject: 'worktree:eng-412-sidebar',
        reason: REASON,
      },
      {
        type: 'permission-granted',
        grantId: grantIdFor({
          callId: CALL,
          subject: 'path:/Users/dennis/Developer/atlas/node_modules',
        }),
        dimensions: [ERiskDimension.Irreversibility, ERiskDimension.Blast],
        scope: EGrantScope.Thread,
        subject: 'path:/Users/dennis/Developer/atlas/node_modules',
        reason: REASON,
      },
    ])
  })

  it('mints rows the log will actually accept', () => {
    for (const draft of drafts) expect(() => eventBodySchema.parse(draft)).not.toThrow()
  })

  it('grants nothing when the operator only proceeded once', () => {
    expect(
      answerDrafts({ callId: CALL, choice: EApprovalChoice.Proceed, grantables: OFFERS }),
    ).toEqual([{ type: 'approval-answered', callId: CALL, decision: EDecision.Allow }])
  })

  it('grants nothing when the drawer offered nothing, whatever key was pressed', () => {
    expect(answerDrafts({ callId: CALL, choice: EApprovalChoice.Always, grantables: [] })).toEqual([
      { type: 'approval-answered', callId: CALL, decision: EDecision.Allow },
    ])
  })
})

describe('the offer the drawer reads off the log', () => {
  it('comes from the weighing of that call, not from the judge prose', () => {
    const question = unansweredApproval({ events: log([judged(OFFERS), asked]), callId: CALL })

    expect(question?.grantables).toEqual(OFFERS)
  })

  it('is empty for a row that named none, which hides the choice', () => {
    const question = unansweredApproval({ events: log([judged(undefined), asked]), callId: CALL })
    if (question === null) throw new Error('the pause carried no question')

    expect(offersToStopAsking(openApproval(question))).toBe(false)
  })
})
