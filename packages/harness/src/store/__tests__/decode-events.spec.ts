import { afterEach, describe, expect, it } from 'bun:test'

import { toThreadId, toEventId, toRunId, type EventDraft } from '@dltech/atlas-core'

import { decodeEventRows, EUnreadableReason, EventDecodeCache } from '../decode-events'
import type { EventRow } from '../event-row'
import { openStoreFixture, type StoreFixture } from './harness'

const threadId = toThreadId('thread-1')
const runId = toRunId('run-1')

const said = (text: string): EventDraft => ({ type: 'user-said', text })

function rowAt({
  seq,
  body,
  type = 'user-said',
  id = `event-${seq}`,
  rowThreadId = 'thread-1',
  runIdColumn = 'run-1',
}: {
  seq: number
  body: string
  type?: string
  id?: string
  rowThreadId?: string
  runIdColumn?: string
}): EventRow {
  return {
    id,
    threadId: rowThreadId,
    seq,
    runId: runIdColumn,
    parentRunId: null,
    depth: 0,
    at: '2026-01-01T00:00:00.000Z',
    type,
    body,
    contextSlot: null,
    contextKey: null,
    contextDigest: null,
  }
}

const validRow = (seq: number, text: string): EventRow =>
  rowAt({ seq, body: JSON.stringify(said(text)) })

describe('decodeEventRows', () => {
  it('stamps a valid row into an event', () => {
    const decoded = decodeEventRows({ rows: [validRow(1, 'hello')] })

    expect(decoded.unreadable).toEqual([])
    expect(decoded.events).toHaveLength(1)
    const [event] = decoded.events
    expect(event?.type).toBe('user-said')
    expect(event?.seq).toBe(1)
    expect(event?.id).toBe(toEventId('event-1'))
    expect(event?.threadId).toBe(threadId)
    expect(event?.runId).toBe(runId)
  })

  it('reports a row whose body is not JSON instead of throwing', () => {
    const decoded = decodeEventRows({ rows: [rowAt({ seq: 1, body: '{not json' })] })

    expect(decoded.events).toEqual([])
    expect(decoded.unreadable).toHaveLength(1)
    const [gap] = decoded.unreadable
    expect(gap?.seq).toBe(1)
    expect(gap?.id).toBe('event-1')
    expect(gap?.threadId).toBe('thread-1')
    expect(gap?.reason).toBe(EUnreadableReason.MalformedJson)
    expect(gap?.detail.length).toBeGreaterThan(0)
  })

  it('reports a row that parses but does not match the schema', () => {
    const decoded = decodeEventRows({
      rows: [rowAt({ seq: 1, body: JSON.stringify({ type: 'user-said' }) })],
    })

    expect(decoded.events).toEqual([])
    expect(decoded.unreadable).toHaveLength(1)
    expect(decoded.unreadable[0]?.reason).toBe(EUnreadableReason.UnrecognizedBody)
    expect(decoded.unreadable[0]?.type).toBe('user-said')
  })

  it('reports a row whose discriminant no longer exists', () => {
    const decoded = decodeEventRows({
      rows: [rowAt({ seq: 1, body: JSON.stringify({ type: 'nudge', text: 'stay on task' }), type: 'nudge' })],
    })

    expect(decoded.events).toEqual([])
    expect(decoded.unreadable[0]?.reason).toBe(EUnreadableReason.UnrecognizedBody)
    expect(decoded.unreadable[0]?.type).toBe('nudge')
  })

  it('reports a row whose id column is empty instead of throwing', () => {
    const decoded = decodeEventRows({ rows: [rowAt({ seq: 1, body: JSON.stringify(said('one')), id: '' })] })

    expect(decoded.events).toEqual([])
    expect(decoded.unreadable).toHaveLength(1)
    const [gap] = decoded.unreadable
    expect(gap?.reason).toBe(EUnreadableReason.CorruptEnvelope)
    expect(gap?.id).toBe('')
    expect(gap?.seq).toBe(1)
    expect(gap?.threadId).toBe('thread-1')
  })

  it('reports a row whose threadId column is empty instead of throwing', () => {
    const decoded = decodeEventRows({
      rows: [rowAt({ seq: 1, body: JSON.stringify(said('one')), rowThreadId: '' })],
    })

    expect(decoded.events).toEqual([])
    expect(decoded.unreadable[0]?.reason).toBe(EUnreadableReason.CorruptEnvelope)
    expect(decoded.unreadable[0]?.threadId).toBe('')
    expect(decoded.unreadable[0]?.id).toBe('event-1')
  })

  it('reports a row whose runId column is empty instead of throwing', () => {
    const decoded = decodeEventRows({
      rows: [rowAt({ seq: 1, body: JSON.stringify(said('one')), runIdColumn: '' })],
    })

    expect(decoded.events).toEqual([])
    expect(decoded.unreadable[0]?.reason).toBe(EUnreadableReason.CorruptEnvelope)
  })

  it('reports a corrupt envelope once, even when the body is also unreadable', () => {
    const decoded = decodeEventRows({ rows: [rowAt({ seq: 1, body: '{ truncated', id: '' })] })

    expect(decoded.events).toEqual([])
    expect(decoded.unreadable).toHaveLength(1)
    expect(decoded.unreadable[0]?.reason).toBe(EUnreadableReason.CorruptEnvelope)
  })

  it('keeps the good rows on both sides of a corrupt envelope, in seq order', () => {
    const decoded = decodeEventRows({
      rows: [
        validRow(1, 'one'),
        rowAt({ seq: 2, body: JSON.stringify(said('two')), id: '' }),
        validRow(3, 'three'),
        rowAt({ seq: 4, body: '{ truncated', rowThreadId: '' }),
        validRow(5, 'five'),
      ],
    })

    expect(decoded.events.map((event) => event.seq)).toEqual([1, 3, 5])
    expect(decoded.unreadable.map((gap) => gap.seq)).toEqual([2, 4])
    expect(decoded.unreadable.every((gap) => gap.reason === EUnreadableReason.CorruptEnvelope)).toBe(true)
  })

  it('keeps the good rows on both sides of a bad one, in seq order', () => {
    const decoded = decodeEventRows({
      rows: [
        validRow(1, 'one'),
        rowAt({ seq: 2, body: '<<corrupt>>' }),
        validRow(3, 'three'),
        rowAt({ seq: 4, body: JSON.stringify({ type: 'tool-failed', callId: 'call-1' }), type: 'tool-failed' }),
        validRow(5, 'five'),
      ],
    })

    expect(decoded.events.map((event) => event.seq)).toEqual([1, 3, 5])
    expect(decoded.events.map((event) => (event.type === 'user-said' ? event.text : null))).toEqual([
      'one',
      'three',
      'five',
    ])
    expect(decoded.unreadable.map((gap) => gap.seq)).toEqual([2, 4])
    expect(decoded.unreadable.map((gap) => gap.reason)).toEqual([
      EUnreadableReason.MalformedJson,
      EUnreadableReason.UnrecognizedBody,
    ])
  })

  it('decodes nothing from nothing', () => {
    expect(decodeEventRows({ rows: [] })).toEqual({ events: [], unreadable: [] })
  })
})

describe('decodeEventRows with an EventDecodeCache', () => {
  it('serves the same event object for a row it has already decoded', () => {
    const cache = new EventDecodeCache()
    const first = decodeEventRows({ rows: [validRow(1, 'one')], cache })
    const second = decodeEventRows({ rows: [validRow(1, 'one')], cache })

    expect(second.events[0]).toBe(first.events[0])
  })

  it('does not re-parse a seen row even if the row handed back differs', () => {
    const cache = new EventDecodeCache()
    decodeEventRows({ rows: [validRow(1, 'one')], cache })

    const rewritten = decodeEventRows({ rows: [validRow(1, 'rewritten')], cache })
    const [event] = rewritten.events
    expect(event?.type).toBe('user-said')
    expect(event && 'text' in event ? event.text : null).toBe('one')
  })

  it('re-decodes a repeated row when no cache is given', () => {
    decodeEventRows({ rows: [validRow(1, 'one')] })

    const rewritten = decodeEventRows({ rows: [validRow(1, 'rewritten')] })
    const [event] = rewritten.events
    expect(event && 'text' in event ? event.text : null).toBe('rewritten')
  })

  it('serves the same gap for a row that failed to decode', () => {
    const cache = new EventDecodeCache()
    const rows = [rowAt({ seq: 1, body: '{ truncated' })]
    const first = decodeEventRows({ rows, cache })
    const second = decodeEventRows({ rows, cache })

    expect(second.unreadable[0]).toBe(first.unreadable[0])
  })

  it('never caches a row with an empty id, so corrupt envelopes stay distinct', () => {
    const cache = new EventDecodeCache()
    const rows = [
      rowAt({ seq: 1, body: '{ truncated', id: '' }),
      rowAt({ seq: 2, body: '{ also truncated', id: '' }),
    ]

    const decoded = decodeEventRows({ rows, cache })
    expect(decoded.unreadable.map((gap) => gap.seq)).toEqual([1, 2])
  })

  it('evicts the oldest rows once it holds more than its byte cap', () => {
    const big = (seq: number) => rowAt({ seq, body: JSON.stringify(said('x'.repeat(100))) })
    const cache = new EventDecodeCache(250)

    decodeEventRows({ rows: [big(1)], cache })
    decodeEventRows({ rows: [big(2)], cache })
    decodeEventRows({ rows: [big(3)], cache })

    const [evicted] = decodeEventRows({ rows: [validRow(1, 'changed')], cache }).events
    expect(evicted && 'text' in evicted ? evicted.text : null).toBe('changed')

    const [kept] = decodeEventRows({ rows: [validRow(3, 'changed')], cache }).events
    expect(kept && 'text' in kept ? kept.text : null).toBe('x'.repeat(100))
  })
})

describe('PrismaEventLog over a corrupted row', () => {
  let fixture: StoreFixture | undefined

  afterEach(async () => {
    await fixture?.close()
    fixture = undefined
  })

  it('reads the surviving events and reports where the gap is', async () => {
    fixture = await openStoreFixture()
    const { log, prisma } = fixture

    const appended = await log.append({ threadId, runId, drafts: [said('one'), said('two'), said('three')] })
    const corrupted = appended[1]
    if (!corrupted) throw new Error('expected three appended events')
    await prisma.event.update({ where: { id: corrupted.id }, data: { body: '{ truncated' } })

    const events = await log.read({ threadId })
    expect(events.map((event) => event.seq)).toEqual([1, 3])

    const decoded = await log.readDecoded({ threadId })
    expect(decoded.events.map((event) => event.seq)).toEqual([1, 3])
    expect(decoded.unreadable.map((gap) => gap.seq)).toEqual([2])
    expect(decoded.unreadable[0]?.id).toBe(corrupted.id)
  })
})

describe('PrismaEventLog decode reuse', () => {
  let fixture: StoreFixture | undefined

  afterEach(async () => {
    await fixture?.close()
    fixture = undefined
  })

  it('decodes each row once no matter how often the thread is read', async () => {
    fixture = await openStoreFixture()
    const { log } = fixture

    await log.append({ threadId, runId, drafts: [said('one'), said('two')] })

    const first = await log.read({ threadId })
    const second = await log.read({ threadId })
    expect(second[0]).toBe(first[0])
    expect(second[1]).toBe(first[1])

    await log.append({ threadId, runId, drafts: [said('three')] })
    const third = await log.read({ threadId })
    expect(third.map((event) => event.seq)).toEqual([1, 2, 3])
    expect(third[0]).toBe(first[0])
    expect(third[1]).toBe(first[1])
  })
})
