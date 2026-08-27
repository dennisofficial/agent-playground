import { describe, expect, it } from 'bun:test'

import {
  stampDrafts,
  toThreadId,
  toEventId,
  toRunId,
  type Event,
  type EventDraft,
  type EventLogPort,
} from '@dltech/atlas-core'

import { createDeltaChannel, EStepEnd, withDeltaPublishing } from '..'
import { assistantEvent, recorder, stepEnded } from './signals'

const threadId = toThreadId('thread-1')
const otherThreadId = toThreadId('thread-2')
const runId = toRunId('run-1')

function fakeLog(): EventLogPort & { readonly rows: Event[] } {
  const rows: Event[] = []

  return {
    rows,

    async append({ threadId: target, runId: run, drafts }) {
      const envelopes = drafts.map((_: EventDraft, index: number) => ({
        id: toEventId(`event-${rows.length + index + 1}`),
        seq: rows.length + index + 1,
        threadId: target,
        runId: run,
        depth: 0,
        at: '2026-08-24T00:00:00.000Z',
      }))
      const stamped = stampDrafts({ drafts, envelopes })
      rows.push(...stamped)
      return stamped
    },

    async read() {
      return [...rows]
    },

    async head() {
      return rows.length
    },

    async readOwn({ threadId, upTo }) {
      return this.read({ threadId, ...(upTo === undefined ? {} : { upTo }) })
    },
  }
}

describe('the log that publishes what it commits', () => {
  it('ends the step in flight naming the assistant event it just wrote', async () => {
    const channel = createDeltaChannel()
    const log = withDeltaPublishing({ log: fakeLog(), channel })
    const { seen, listener } = recorder()
    channel.subscribe({ threadId, listener })
    channel.publisherFor({ threadId }).onChunk({ type: 'text-delta', id: 't1', text: 'auth' })

    const appended = await log.append({
      threadId,
      runId,
      drafts: [{ type: 'assistant-said', parts: [{ type: 'text', text: 'auth' }] }],
    })

    const written = assistantEvent(appended)
    const ended = stepEnded(seen)
    expect(ended.supersededBy).toEqual({ eventId: written.id, seq: written.seq })
    expect(ended.end).toBe(EStepEnd.Completed)
  })

  it('returns the stamped events unchanged to its caller', async () => {
    const inner = fakeLog()
    const log = withDeltaPublishing({ log: inner, channel: createDeltaChannel() })

    const appended = await log.append({ threadId, runId, drafts: [{ type: 'user-said', text: 'what changed?' }] })

    expect(appended).toEqual(inner.rows)
    expect(await log.read({ threadId })).toEqual(inner.rows)
    expect(await log.head({ threadId })).toBe(1)
  })

  it('leaves the step in flight on another thread alone', async () => {
    const channel = createDeltaChannel()
    const log = withDeltaPublishing({ log: fakeLog(), channel })
    const { seen, listener } = recorder()
    channel.subscribe({ threadId, listener })
    channel.publisherFor({ threadId }).onChunk({ type: 'text-delta', id: 't1', text: 'auth' })

    await log.append({
      threadId: otherThreadId,
      runId,
      drafts: [{ type: 'assistant-said', parts: [{ type: 'text', text: 'elsewhere' }] }],
    })

    expect(seen.some((signal) => signal.type === 'step-ended')).toBe(false)
  })
})
