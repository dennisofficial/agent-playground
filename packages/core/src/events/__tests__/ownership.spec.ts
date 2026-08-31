import { describe, expect, it } from 'bun:test'

import { toEventId, toRunId, toThreadId } from '../ids'
import { rowsOwnedBy } from '../ownership'
import type { Event } from '../envelope'

const PARENT = toThreadId('parent-thread')
const CHILD = toThreadId('child-thread')

const said = (args: { threadId: string; seq: number; text: string }): Event => ({
  type: 'user-said',
  text: args.text,
  id: toEventId(`event-${args.seq}`),
  seq: args.seq,
  threadId: toThreadId(args.threadId),
  runId: toRunId('run-1'),
  depth: 0,
  at: '2026-01-01T00:00:00.000Z',
})

describe('rowsOwnedBy', () => {
  it('keeps every row of a thread that inherited nothing', () => {
    const events = [
      said({ threadId: CHILD, seq: 1, text: 'one' }),
      said({ threadId: CHILD, seq: 2, text: 'two' }),
    ]

    expect(rowsOwnedBy({ events, threadId: CHILD })).toEqual(events)
  })

  it('drops the rows a child only reads through its parent', () => {
    const events = [
      said({ threadId: PARENT, seq: 1, text: 'the parent said this' }),
      said({ threadId: CHILD, seq: 2, text: 'the brief' }),
    ]

    expect(rowsOwnedBy({ events, threadId: CHILD }).map((event) => event.seq)).toEqual([2])
  })

  it('keeps the order the composed read handed over', () => {
    const events = [
      said({ threadId: CHILD, seq: 1, text: 'one' }),
      said({ threadId: PARENT, seq: 2, text: 'inherited' }),
      said({ threadId: CHILD, seq: 3, text: 'three' }),
    ]

    expect(rowsOwnedBy({ events, threadId: CHILD }).map((event) => event.seq)).toEqual([1, 3])
  })

  it('answers with nothing when the thread owns nothing yet', () => {
    expect(
      rowsOwnedBy({ events: [said({ threadId: PARENT, seq: 1, text: 'one' })], threadId: CHILD }),
    ).toEqual([])
  })
})
