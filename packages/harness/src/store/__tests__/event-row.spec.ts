import { afterEach, describe, expect, it } from 'bun:test'

import {
  pendingCalls,
  toThreadId,
  toCallId,
  toEventId,
  toRunId,
  type EventDraft,
  type EventEnvelope,
} from '@dltech/atlas-core'

import { toEventRow, UnreadableWrite } from '../event-row'
import { openStoreFixture, type StoreFixture } from './harness'

const threadId = toThreadId('thread-1')
const runId = toRunId('run-1')
const callId = toCallId('call-1')

const envelope: EventEnvelope = {
  id: toEventId('event-1'),
  seq: 1,
  threadId,
  runId,
  depth: 0,
  at: '2026-01-01T00:00:00.000Z',
}

let fixture: StoreFixture | undefined

afterEach(async () => {
  await fixture?.close()
  fixture = undefined
})

describe('toEventRow', () => {
  it('refuses a draft whose serialized body it could not read back', () => {
    const draft: EventDraft = { type: 'nudge', text: 'stay on task', lifetimeSteps: Number.NaN }

    expect(() => toEventRow({ draft, envelope })).toThrow(UnreadableWrite)
    expect(() => toEventRow({ draft, envelope })).toThrow('nudge')
  })
})

describe('a tool result that carries an error rather than an output', () => {
  const failed: EventDraft = {
    type: 'tool-result',
    callId,
    name: 'shell_output',
    output: undefined,
    error: { message: 'no background shell is registered as "bash_2"' },
  }

  it('writes a body with no output key at all', () => {
    const row = toEventRow({ draft: failed, envelope })

    expect(JSON.parse(row.body)).not.toHaveProperty('output')
  })

  it('reads back as the settling of its call, so the call stops being pending', async () => {
    fixture = await openStoreFixture()

    await fixture.log.append({
      threadId,
      runId,
      drafts: [
        { type: 'tool-called', callId, name: 'shell_output', input: { shellId: 'bash_2' }, ordinal: 0 },
        failed,
      ],
    })
    const events = await fixture.log.read({ threadId })

    expect(events.map((event) => event.type)).toEqual(['tool-called', 'tool-result'])
    expect(pendingCalls(events)).toEqual([])
    const settled = events[1]
    expect(settled?.type === 'tool-result' && settled.error?.message).toContain('bash_2')
  })
})
