import { describe, expect, it } from 'bun:test'

import { EDecision, type EventDraft } from '../body'
import type { Event } from '../envelope'
import { toBranchId, toCallId, toEventId, toRunId } from '../ids'
import { answeredApproval, inputForCall, outstandingApproval, pendingCalls } from '../projections'
import { stampDrafts } from '../stamp'

const eventsFrom = (drafts: readonly EventDraft[]): Event[] =>
  stampDrafts({
    drafts,
    envelopes: drafts.map((_, index) => ({
      id: toEventId(`evt-${index + 1}`),
      seq: index + 1,
      branchId: toBranchId('branch-1'),
      runId: toRunId('run-1'),
      depth: 0,
      at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    })),
  })

const called = (args: { callId: string; ordinal: number; input?: unknown }): EventDraft => ({
  type: 'tool-called',
  callId: toCallId(args.callId),
  name: 'read_file',
  input: args.input ?? { path: '/a' },
  ordinal: args.ordinal,
})

describe('pendingCalls', () => {
  it('is empty for a conversation of spoken turns only', () => {
    const events = eventsFrom([
      { type: 'user-said', text: 'hello' },
      { type: 'assistant-said', parts: [{ type: 'text', text: 'hi' }] },
    ])

    expect(pendingCalls(events)).toEqual([])
  })

  it('holds a call that has neither a result nor a denial', () => {
    const events = eventsFrom([called({ callId: 'call-1', ordinal: 0 })])

    expect(pendingCalls(events)).toEqual([
      { callId: toCallId('call-1'), name: 'read_file', input: { path: '/a' }, ordinal: 0 },
    ])
  })

  it('drops a call once a result arrives', () => {
    const events = eventsFrom([
      called({ callId: 'call-1', ordinal: 0 }),
      { type: 'tool-result', callId: toCallId('call-1'), name: 'read_file', output: 'contents' },
    ])

    expect(pendingCalls(events)).toEqual([])
  })

  it('drops a call once it is denied', () => {
    const events = eventsFrom([
      called({ callId: 'call-1', ordinal: 0 }),
      { type: 'tool-denied', callId: toCallId('call-1'), name: 'read_file', reason: 'outside workspace' },
    ])

    expect(pendingCalls(events)).toEqual([])
  })

  it('treats a failed result as settled rather than pending', () => {
    const events = eventsFrom([
      called({ callId: 'call-1', ordinal: 0 }),
      {
        type: 'tool-result',
        callId: toCallId('call-1'),
        name: 'read_file',
        output: undefined,
        error: { message: 'ENOENT' },
      },
    ])

    expect(pendingCalls(events)).toEqual([])
  })

  it('returns the calls in log order, carrying the ordinal of each', () => {
    const events = eventsFrom([
      called({ callId: 'call-1', ordinal: 0 }),
      called({ callId: 'call-2', ordinal: 1 }),
    ])

    expect(pendingCalls(events).map((call) => [call.callId, call.ordinal])).toEqual([
      [toCallId('call-1'), 0],
      [toCallId('call-2'), 1],
    ])
  })
})

describe('answeredApproval', () => {
  it('is undefined when nothing answered the call', () => {
    const events = eventsFrom([{ type: 'approval-requested', callId: toCallId('call-1'), reason: 'writes' }])

    expect(answeredApproval({ events, callId: toCallId('call-1') })).toBeUndefined()
  })

  it('returns the latest answer for the call', () => {
    const events = eventsFrom([
      { type: 'approval-requested', callId: toCallId('call-1'), reason: 'writes' },
      { type: 'approval-answered', callId: toCallId('call-1'), decision: EDecision.Deny },
      { type: 'approval-answered', callId: toCallId('call-1'), decision: EDecision.Allow },
    ])

    expect(answeredApproval({ events, callId: toCallId('call-1') })?.decision).toBe(EDecision.Allow)
  })

  it('ignores answers belonging to another call', () => {
    const events = eventsFrom([
      { type: 'approval-answered', callId: toCallId('call-2'), decision: EDecision.Allow },
    ])

    expect(answeredApproval({ events, callId: toCallId('call-1') })).toBeUndefined()
  })
})

describe('outstandingApproval', () => {
  it('is undefined when nothing was ever asked', () => {
    const events = eventsFrom([{ type: 'user-said', text: 'hello' }])

    expect(outstandingApproval(events)).toBeUndefined()
  })

  it('names the call whose request has no answer', () => {
    const events = eventsFrom([
      { type: 'approval-requested', callId: toCallId('call-1'), reason: 'writes' },
    ])

    expect(outstandingApproval(events)).toBe(toCallId('call-1'))
  })

  it('is undefined once every request is answered', () => {
    const events = eventsFrom([
      { type: 'approval-requested', callId: toCallId('call-1'), reason: 'writes' },
      { type: 'approval-answered', callId: toCallId('call-1'), decision: EDecision.Deny },
    ])

    expect(outstandingApproval(events)).toBeUndefined()
  })

  it('names the earliest unanswered request', () => {
    const events = eventsFrom([
      { type: 'approval-requested', callId: toCallId('call-1'), reason: 'writes' },
      { type: 'approval-requested', callId: toCallId('call-2'), reason: 'deletes' },
      { type: 'approval-answered', callId: toCallId('call-2'), decision: EDecision.Allow },
    ])

    expect(outstandingApproval(events)).toBe(toCallId('call-1'))
  })
})

describe('inputForCall', () => {
  it('is the input the model asked for when no approval edited it', () => {
    const events = eventsFrom([called({ callId: 'call-1', ordinal: 0 })])

    expect(inputForCall({ events, callId: toCallId('call-1') })).toEqual({ path: '/a' })
  })

  it('is the human edit when an approval allowed with edited input', () => {
    const events = eventsFrom([
      called({ callId: 'call-1', ordinal: 0 }),
      {
        type: 'approval-answered',
        callId: toCallId('call-1'),
        decision: EDecision.Allow,
        editedInput: { path: '/b' },
      },
    ])

    expect(inputForCall({ events, callId: toCallId('call-1') })).toEqual({ path: '/b' })
  })

  it('ignores edited input carried by a denial', () => {
    const events = eventsFrom([
      called({ callId: 'call-1', ordinal: 0 }),
      {
        type: 'approval-answered',
        callId: toCallId('call-1'),
        decision: EDecision.Deny,
        editedInput: { path: '/b' },
      },
    ])

    expect(inputForCall({ events, callId: toCallId('call-1') })).toEqual({ path: '/a' })
  })

  it('is undefined for a call that was never made', () => {
    expect(inputForCall({ events: [], callId: toCallId('call-1') })).toBeUndefined()
  })
})
