import { describe, expect, it } from 'bun:test'

import { EDecision, type EventDraft } from '../body'
import type { Event } from '../envelope'
import { toThreadId, toCallId, toEventId, toRunId } from '../ids'
import { ERewindRefusal, rewindTarget } from '../rewind-target'
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

const said = (text: string): EventDraft => ({ type: 'user-said', text })
const replied = (text: string): EventDraft => ({
  type: 'assistant-said',
  parts: [{ type: 'text', text }],
})
const called = (callId: string): EventDraft => ({
  type: 'tool-called',
  callId: toCallId(callId),
  name: 'bash',
  input: { command: 'rm -rf build' },
  ordinal: 0,
})
const resulted = (callId: string): EventDraft => ({
  type: 'tool-result',
  callId: toCallId(callId),
  name: 'bash',
  output: { ok: true },
})

const exchange = (): Event[] =>
  eventsFrom([said('clean the build'), replied('on it'), called('call-1'), resulted('call-1'), replied('done')])

describe('rewindTarget', () => {
  it('refuses a target that would leave a dispatched tool call unsettled for the next turn to dispatch again', () => {
    const target = rewindTarget({ events: exchange(), toSeq: 3 })

    expect(target.allowed).toBe(false)
    expect(target).toMatchObject({ refusal: ERewindRefusal.UnsettledToolCall })
    if (!target.allowed) expect(target.reason).toContain('bash')
  })

  it('allows a target whose surviving prefix has every call settled', () => {
    expect(rewindTarget({ events: exchange(), toSeq: 4 })).toEqual({ allowed: true })
    expect(rewindTarget({ events: exchange(), toSeq: 2 })).toEqual({ allowed: true })
  })

  it('allows emptying the thread', () => {
    expect(rewindTarget({ events: exchange(), toSeq: 0 })).toEqual({ allowed: true })
  })

  it('judges the surviving prefix, not the last surviving event', () => {
    const events = eventsFrom([
      said('two tools'),
      called('call-1'),
      called('call-2'),
      resulted('call-1'),
      resulted('call-2'),
    ])

    expect(rewindTarget({ events, toSeq: 4 })).toMatchObject({
      allowed: false,
      refusal: ERewindRefusal.UnsettledToolCall,
    })
    expect(rewindTarget({ events, toSeq: 5 })).toEqual({ allowed: true })
  })

  it('refuses a target that would leave an approval unanswered', () => {
    const events = eventsFrom([
      said('delete it'),
      { type: 'approval-requested', callId: toCallId('call-1'), reason: 'bash writes' },
      { type: 'approval-answered', callId: toCallId('call-1'), decision: EDecision.Allow },
    ])

    expect(rewindTarget({ events, toSeq: 2 })).toMatchObject({
      allowed: false,
      refusal: ERewindRefusal.UnansweredApproval,
    })
    expect(rewindTarget({ events, toSeq: 3 })).toEqual({ allowed: true })
  })

  it('refuses a sequence the thread never reached', () => {
    expect(rewindTarget({ events: exchange(), toSeq: 6 })).toMatchObject({
      allowed: false,
      refusal: ERewindRefusal.NoSuchTarget,
    })
    expect(rewindTarget({ events: exchange(), toSeq: -1 })).toMatchObject({
      allowed: false,
      refusal: ERewindRefusal.NoSuchTarget,
    })
    expect(rewindTarget({ events: exchange(), toSeq: 2.5 })).toMatchObject({
      allowed: false,
      refusal: ERewindRefusal.NoSuchTarget,
    })
  })
})
