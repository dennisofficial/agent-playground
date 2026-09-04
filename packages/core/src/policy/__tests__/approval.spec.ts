import { describe, expect, it } from 'bun:test'

import { EDecision, type EventDraft } from '../../events/body'
import type { Event } from '../../events/envelope'
import { toCallId, toEventId, toRunId, toThreadId } from '../../events/ids'
import { stampDrafts } from '../../events/stamp'
import { EApprovalResolution, resolveApproval } from '../approval'

const CALL = toCallId('call-1')

const eventsFrom = (drafts: readonly EventDraft[]): Event[] =>
  stampDrafts({
    drafts,
    envelopes: drafts.map((_, index) => ({
      id: toEventId(`evt-${index + 1}`),
      seq: index + 1,
      threadId: toThreadId('thread-1'),
      runId: toRunId('run-1'),
      depth: 0,
      at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    })),
  })

const called: EventDraft = {
  type: 'tool-called',
  callId: CALL,
  name: 'write',
  input: { path: 'notes.md' },
  ordinal: 0,
}

const asked: EventDraft = { type: 'approval-requested', callId: CALL, reason: 'writing outside the worktree' }

describe('resolving an approval the operator has answered', () => {
  it('refuses a denied call, naming what the operator was asked', () => {
    const events = eventsFrom([
      called,
      asked,
      { type: 'approval-answered', callId: CALL, decision: EDecision.Deny },
    ])

    expect(resolveApproval({ events, callId: CALL, input: { path: 'notes.md' } })).toEqual({
      resolution: EApprovalResolution.Refused,
      reason: 'the operator declined this call: writing outside the worktree',
    })
  })

  it('refuses a denied call that nothing on the log asked about', () => {
    const events = eventsFrom([
      called,
      { type: 'approval-answered', callId: CALL, decision: EDecision.Deny },
    ])

    expect(resolveApproval({ events, callId: CALL, input: { path: 'notes.md' } })).toEqual({
      resolution: EApprovalResolution.Refused,
      reason: 'the operator declined this call',
    })
  })

  it('hands back the edited input when the operator allowed a changed call', () => {
    const events = eventsFrom([
      called,
      asked,
      {
        type: 'approval-answered',
        callId: CALL,
        decision: EDecision.Allow,
        editedInput: { path: 'docs/notes.md' },
      },
    ])

    expect(resolveApproval({ events, callId: CALL, input: { path: 'notes.md' } })).toEqual({
      resolution: EApprovalResolution.Dispatch,
      input: { path: 'docs/notes.md' },
    })
  })

  it('hands back the input the model asked for when the operator edited nothing', () => {
    const events = eventsFrom([
      called,
      asked,
      { type: 'approval-answered', callId: CALL, decision: EDecision.Allow },
    ])

    expect(resolveApproval({ events, callId: CALL, input: { path: 'notes.md' } })).toEqual({
      resolution: EApprovalResolution.Dispatch,
      input: { path: 'notes.md' },
    })
  })

  it('reads the last answer, so a mind changed after a denial dispatches', () => {
    const events = eventsFrom([
      called,
      asked,
      { type: 'approval-answered', callId: CALL, decision: EDecision.Deny },
      { type: 'approval-answered', callId: CALL, decision: EDecision.Allow },
    ])

    expect(resolveApproval({ events, callId: CALL, input: { path: 'notes.md' } })).toEqual({
      resolution: EApprovalResolution.Dispatch,
      input: { path: 'notes.md' },
    })
  })

  it('dispatches an unanswered call untouched', () => {
    const events = eventsFrom([called, asked])

    expect(resolveApproval({ events, callId: CALL, input: { path: 'notes.md' } })).toEqual({
      resolution: EApprovalResolution.Dispatch,
      input: { path: 'notes.md' },
    })
  })

  it('keeps each pending occurrence of a reused call id with its own input', () => {
    const events = eventsFrom([
      called,
      {
        type: 'tool-called',
        callId: CALL,
        name: 'write',
        input: { path: 'later.md' },
        ordinal: 0,
      },
    ])

    expect(resolveApproval({ events, callId: CALL, input: { path: 'notes.md' } })).toEqual({
      resolution: EApprovalResolution.Dispatch,
      input: { path: 'notes.md' },
    })
  })
})
