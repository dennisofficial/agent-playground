import { describe, expect, it } from 'bun:test'

import { EAgentStatus } from '../../agents/status'
import { EDecision, type EventDraft } from '../body'
import type { Event } from '../envelope'
import { toThreadId, toCallId, toEventId, toRunId } from '../ids'
import {
  answeredApproval,
  awaitsReply,
  inputForCall,
  outstandingApproval,
  pendingCalls,
} from '../projections'
import { stampDrafts } from '../stamp'

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

const called = (args: { callId: string; ordinal: number; input?: unknown }): EventDraft => ({
  type: 'tool-called',
  callId: toCallId(args.callId),
  name: 'read_file',
  input: args.input ?? { path: '/a' },
  ordinal: args.ordinal,
})

const eventsAcrossRuns = (entries: readonly { draft: EventDraft; runId: string }[]): Event[] =>
  stampDrafts({
    drafts: entries.map((entry) => entry.draft),
    envelopes: entries.map((entry, index) => ({
      id: toEventId(`evt-${index + 1}`),
      seq: index + 1,
      threadId: toThreadId('thread-1'),
      runId: toRunId(entry.runId),
      depth: 0,
      at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    })),
  })

describe('pendingCalls', () => {
  it('names the run that emitted each call, so a resume keys the tool the same way', () => {
    const events = eventsAcrossRuns([
      { draft: called({ callId: 'call-1', ordinal: 0 }), runId: 'run-1' },
      { draft: called({ callId: 'call-2', ordinal: 0 }), runId: 'run-2' },
    ])

    expect(pendingCalls(events).map((call) => call.runId)).toEqual([toRunId('run-1'), toRunId('run-2')])
  })

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
      {
        callId: toCallId('call-1'),
        name: 'read_file',
        input: { path: '/a' },
        ordinal: 0,
        runId: toRunId('run-1'),
        threadId: toThreadId('thread-1'),
      },
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

describe('a call id the provider hands out twice', () => {
  const resulted = (args: { callId: string }): EventDraft => ({
    type: 'tool-result',
    callId: toCallId(args.callId),
    name: 'read_file',
    output: 'contents',
  })

  it('holds the fresh call as pending — an older result with the same id settles nothing new', () => {
    const events = eventsAcrossRuns([
      { draft: called({ callId: 'call-1', ordinal: 0 }), runId: 'run-1' },
      { draft: resulted({ callId: 'call-1' }), runId: 'run-1' },
      { draft: called({ callId: 'call-1', ordinal: 0, input: { path: '/fresh' } }), runId: 'run-2' },
    ])

    expect(pendingCalls(events).map((call) => [call.runId, call.input])).toEqual([
      [toRunId('run-2'), { path: '/fresh' }],
    ])
  })

  it('lets one result settle two calls that share an id one at a time, oldest open first', () => {
    const events = eventsFrom([
      called({ callId: 'call-1', ordinal: 0 }),
      called({ callId: 'call-1', ordinal: 1 }),
      resulted({ callId: 'call-1' }),
    ])

    expect(pendingCalls(events).map((call) => call.ordinal)).toEqual([0])
  })

  it('ignores a result that arrives with no open call behind it', () => {
    const events = eventsFrom([
      resulted({ callId: 'call-1' }),
      called({ callId: 'call-1', ordinal: 0 }),
    ])

    expect(pendingCalls(events).map((call) => call.callId)).toEqual([toCallId('call-1')])
  })

  it('answers the input question with the latest call carrying the id', () => {
    const events = eventsFrom([
      called({ callId: 'call-1', ordinal: 0, input: { path: '/stale' } }),
      resulted({ callId: 'call-1' }),
      called({ callId: 'call-1', ordinal: 0, input: { path: '/fresh' } }),
    ])

    expect(inputForCall({ events, callId: toCallId('call-1') })).toEqual({ path: '/fresh' })
  })

  it('stops counting an approval answer once the id is called again', () => {
    const events = eventsFrom([
      called({ callId: 'call-1', ordinal: 0 }),
      { type: 'approval-requested', callId: toCallId('call-1'), reason: 'writes' },
      { type: 'approval-answered', callId: toCallId('call-1'), decision: EDecision.Deny },
      called({ callId: 'call-1', ordinal: 0 }),
    ])

    expect(answeredApproval({ events, callId: toCallId('call-1') })).toBeUndefined()
  })

  it('holds a fresh approval request as outstanding despite the answer the old call got', () => {
    const events = eventsFrom([
      called({ callId: 'call-1', ordinal: 0 }),
      { type: 'approval-requested', callId: toCallId('call-1'), reason: 'writes' },
      { type: 'approval-answered', callId: toCallId('call-1'), decision: EDecision.Allow },
      called({ callId: 'call-1', ordinal: 0 }),
      { type: 'approval-requested', callId: toCallId('call-1'), reason: 'writes again' },
    ])

    expect(outstandingApproval(events)).toBe(toCallId('call-1'))
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

describe('whose turn it is', () => {
  const ENDED_CHILD: EventDraft = {
    type: 'agent-ended',
    agentId: toThreadId('thr_child'),
    agentType: 'explore',
    intent: 'vault audit',
    status: EAgentStatus.Finished,
    prose: 'The vault reads its key file exactly once.',
    turns: 3,
    toolCalls: 9,
  }

  it('hands the turn back after the assistant has spoken', () => {
    const events = eventsFrom([
      { type: 'user-said', text: 'audit the vault' },
      { type: 'assistant-said', parts: [{ type: 'text', text: 'delegating' }] },
    ])

    expect(awaitsReply(events)).toBe(false)
  })

  it('is the assistant to answer when a sub-agent ends, exactly as when a shell ends', () => {
    const spoken: EventDraft = {
      type: 'assistant-said',
      parts: [{ type: 'text', text: 'delegating' }],
    }

    expect(awaitsReply(eventsFrom([{ type: 'user-said', text: 'go' }, spoken, ENDED_CHILD]))).toBe(
      true,
    )
  })

  it('reads an ending as turn-taking even when it is the only row', () => {
    expect(awaitsReply(eventsFrom([ENDED_CHILD]))).toBe(true)
  })

  it('is the assistant to answer when a background shell watch matches mid-run', () => {
    const matched: EventDraft = {
      type: 'background-shell-matched',
      shellId: 'bash_1',
      command: 'bun test',
      pattern: '(fail|error)',
      lines: '12 fail\n',
      matchCount: 1,
    }

    expect(
      awaitsReply(
        eventsFrom([
          { type: 'user-said', text: 'run the suite' },
          { type: 'assistant-said', parts: [{ type: 'text', text: 'backgrounding it' }] },
          matched,
        ]),
      ),
    ).toBe(true)
  })
})
