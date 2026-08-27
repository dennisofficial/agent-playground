import { describe, expect, it } from 'bun:test'

import type { EventDraft } from '../body'
import type { EventEnvelope } from '../envelope'
import { toThreadId, toEventId, toRunId } from '../ids'
import { stampEvent } from '../stamp'

const envelope: EventEnvelope = {
  id: toEventId('evt-1'),
  seq: 7,
  threadId: toThreadId('thread-1'),
  runId: toRunId('run-1'),
  depth: 0,
  at: '2026-08-24T00:00:00.000Z',
}

describe('stampEvent', () => {
  it('adds identity, sequence, thread, run, depth and time to a draft', () => {
    const draft: EventDraft = { type: 'user-said', text: 'hello' }

    expect(stampEvent({ draft, envelope })).toEqual({
      type: 'user-said',
      text: 'hello',
      id: toEventId('evt-1'),
      seq: 7,
      threadId: toThreadId('thread-1'),
      runId: toRunId('run-1'),
      depth: 0,
      at: '2026-08-24T00:00:00.000Z',
    })
  })

  it('adds nothing to the draft beyond the envelope', () => {
    const draft: EventDraft = { type: 'nudge', text: 'stay on task', lifetimeSteps: 2 }

    expect(Object.keys(stampEvent({ draft, envelope })).sort()).toEqual(
      ['at', 'threadId', 'depth', 'id', 'lifetimeSteps', 'runId', 'seq', 'text', 'type'].sort(),
    )
  })

  it('stamps a root run at depth zero with no parent run', () => {
    const stamped = stampEvent({ draft: { type: 'user-said', text: 'hello' }, envelope })

    expect(stamped.depth).toBe(0)
    expect('parentRunId' in stamped).toBe(false)
  })

  it('stamps a nested run with its parent run and its depth', () => {
    const stamped = stampEvent({
      draft: { type: 'user-said', text: 'delegated' },
      envelope: {
        ...envelope,
        runId: toRunId('run-2'),
        parentRunId: toRunId('run-1'),
        depth: 1,
      },
    })

    expect([stamped.parentRunId, stamped.depth]).toEqual([toRunId('run-1'), 1])
  })

  it('passes a reasoning part provider options bag through untouched', () => {
    const signature = { anthropic: { signature: 'sig-abc' } }
    const draft: EventDraft = {
      type: 'assistant-said',
      parts: [{ type: 'reasoning', text: 'thinking', providerOptions: signature }],
    }

    const stamped = stampEvent({ draft, envelope })
    if (stamped.type !== 'assistant-said') throw new Error('expected an assistant turn')
    const part = stamped.parts[0]
    if (part?.type !== 'reasoning') throw new Error('expected a reasoning part')

    expect(part.providerOptions).toBe(signature)
  })

  it('leaves the draft unmutated', () => {
    const draft: EventDraft = { type: 'user-said', text: 'hello' }
    stampEvent({ draft, envelope })

    expect(draft).toEqual({ type: 'user-said', text: 'hello' })
  })
})
