import { toEventId, toRunId, toThreadId, type Event, type EventBody } from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import { sessionDigest } from '../session-rename'

const THREAD = toThreadId('thread')

const RUN = toRunId('run')

const stamped = (body: EventBody, seq: number): Event =>
  ({
    ...body,
    id: toEventId(`event-${seq}`),
    seq,
    threadId: THREAD,
    runId: RUN,
    depth: 0,
    at: new Date(seq * 1000).toISOString(),
  }) as Event

const said = (text: string, seq: number): Event => stamped({ type: 'user-said', text }, seq)

const replied = (text: string, seq: number): Event =>
  stamped({ type: 'assistant-said', parts: [{ type: 'text', text }] }, seq)

describe('sessionDigest', () => {
  it('is empty for a conversation that has said nothing', () => {
    expect(sessionDigest([])).toBe('')
  })

  it('renders both sides of the conversation, so the name can follow the work', () => {
    const digest = sessionDigest([said('rotate the refresh token', 1), replied('rotated it', 2)])

    expect(digest).toContain('rotate the refresh token')
    expect(digest).toContain('rotated it')
  })

  it('keeps the opening and the most recent work when the session is too long to send', () => {
    const events = [
      said('the opening ask', 1),
      ...Array.from({ length: 200 }, (_, index) => replied(`middle ${index}`, index + 2)),
      said('the latest ask', 400),
    ]

    const digest = sessionDigest(events)

    expect(digest).toContain('the opening ask')
    expect(digest).toContain('the latest ask')
    expect(digest).toContain('…')
    expect(digest.length).toBeLessThan(2000)
  })
})
