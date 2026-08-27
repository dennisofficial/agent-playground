import { afterEach, describe, expect, it } from 'bun:test'

import { toBranchId, toEventId, toRunId, type EventDraft } from '@dltech/atlas-core'

import { decodeEventRows, EUnreadableReason } from '../decode-events'
import type { EventRow } from '../event-row'
import { openStoreFixture, type StoreFixture } from './harness'

const branchId = toBranchId('branch-1')
const runId = toRunId('run-1')

const said = (text: string): EventDraft => ({ type: 'user-said', text })

function rowAt({
  seq,
  body,
  type = 'user-said',
  id = `event-${seq}`,
  rowBranchId = 'branch-1',
  runIdColumn = 'run-1',
}: {
  seq: number
  body: string
  type?: string
  id?: string
  rowBranchId?: string
  runIdColumn?: string
}): EventRow {
  return {
    id,
    branchId: rowBranchId,
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
    const decoded = decodeEventRows([validRow(1, 'hello')])

    expect(decoded.unreadable).toEqual([])
    expect(decoded.events).toHaveLength(1)
    const [event] = decoded.events
    expect(event?.type).toBe('user-said')
    expect(event?.seq).toBe(1)
    expect(event?.id).toBe(toEventId('event-1'))
    expect(event?.branchId).toBe(branchId)
    expect(event?.runId).toBe(runId)
  })

  it('reports a row whose body is not JSON instead of throwing', () => {
    const decoded = decodeEventRows([rowAt({ seq: 1, body: '{not json' })])

    expect(decoded.events).toEqual([])
    expect(decoded.unreadable).toHaveLength(1)
    const [gap] = decoded.unreadable
    expect(gap?.seq).toBe(1)
    expect(gap?.id).toBe('event-1')
    expect(gap?.branchId).toBe('branch-1')
    expect(gap?.reason).toBe(EUnreadableReason.MalformedJson)
    expect(gap?.detail.length).toBeGreaterThan(0)
  })

  it('reports a row that parses but does not match the schema', () => {
    const decoded = decodeEventRows([
      rowAt({ seq: 1, body: JSON.stringify({ type: 'user-said' }) }),
    ])

    expect(decoded.events).toEqual([])
    expect(decoded.unreadable).toHaveLength(1)
    expect(decoded.unreadable[0]?.reason).toBe(EUnreadableReason.UnrecognizedBody)
    expect(decoded.unreadable[0]?.type).toBe('user-said')
  })

  it('reports a row whose discriminant no longer exists', () => {
    const decoded = decodeEventRows([
      rowAt({ seq: 1, body: JSON.stringify({ type: 'nudge', text: 'stay on task' }), type: 'nudge' }),
    ])

    expect(decoded.events).toEqual([])
    expect(decoded.unreadable[0]?.reason).toBe(EUnreadableReason.UnrecognizedBody)
    expect(decoded.unreadable[0]?.type).toBe('nudge')
  })

  it('reports a row whose id column is empty instead of throwing', () => {
    const decoded = decodeEventRows([rowAt({ seq: 1, body: JSON.stringify(said('one')), id: '' })])

    expect(decoded.events).toEqual([])
    expect(decoded.unreadable).toHaveLength(1)
    const [gap] = decoded.unreadable
    expect(gap?.reason).toBe(EUnreadableReason.CorruptEnvelope)
    expect(gap?.id).toBe('')
    expect(gap?.seq).toBe(1)
    expect(gap?.branchId).toBe('branch-1')
  })

  it('reports a row whose branchId column is empty instead of throwing', () => {
    const decoded = decodeEventRows([
      rowAt({ seq: 1, body: JSON.stringify(said('one')), rowBranchId: '' }),
    ])

    expect(decoded.events).toEqual([])
    expect(decoded.unreadable[0]?.reason).toBe(EUnreadableReason.CorruptEnvelope)
    expect(decoded.unreadable[0]?.branchId).toBe('')
    expect(decoded.unreadable[0]?.id).toBe('event-1')
  })

  it('reports a row whose runId column is empty instead of throwing', () => {
    const decoded = decodeEventRows([
      rowAt({ seq: 1, body: JSON.stringify(said('one')), runIdColumn: '' }),
    ])

    expect(decoded.events).toEqual([])
    expect(decoded.unreadable[0]?.reason).toBe(EUnreadableReason.CorruptEnvelope)
  })

  it('reports a corrupt envelope once, even when the body is also unreadable', () => {
    const decoded = decodeEventRows([rowAt({ seq: 1, body: '{ truncated', id: '' })])

    expect(decoded.events).toEqual([])
    expect(decoded.unreadable).toHaveLength(1)
    expect(decoded.unreadable[0]?.reason).toBe(EUnreadableReason.CorruptEnvelope)
  })

  it('keeps the good rows on both sides of a corrupt envelope, in seq order', () => {
    const decoded = decodeEventRows([
      validRow(1, 'one'),
      rowAt({ seq: 2, body: JSON.stringify(said('two')), id: '' }),
      validRow(3, 'three'),
      rowAt({ seq: 4, body: '{ truncated', rowBranchId: '' }),
      validRow(5, 'five'),
    ])

    expect(decoded.events.map((event) => event.seq)).toEqual([1, 3, 5])
    expect(decoded.unreadable.map((gap) => gap.seq)).toEqual([2, 4])
    expect(decoded.unreadable.every((gap) => gap.reason === EUnreadableReason.CorruptEnvelope)).toBe(true)
  })

  it('keeps the good rows on both sides of a bad one, in seq order', () => {
    const decoded = decodeEventRows([
      validRow(1, 'one'),
      rowAt({ seq: 2, body: '<<corrupt>>' }),
      validRow(3, 'three'),
      rowAt({ seq: 4, body: JSON.stringify({ type: 'tool-failed', callId: 'call-1' }), type: 'tool-failed' }),
      validRow(5, 'five'),
    ])

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
    expect(decodeEventRows([])).toEqual({ events: [], unreadable: [] })
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

    const appended = await log.append({ branchId, runId, drafts: [said('one'), said('two'), said('three')] })
    const corrupted = appended[1]
    if (!corrupted) throw new Error('expected three appended events')
    await prisma.event.update({ where: { id: corrupted.id }, data: { body: '{ truncated' } })

    const events = await log.read({ branchId })
    expect(events.map((event) => event.seq)).toEqual([1, 3])

    const decoded = await log.readDecoded({ branchId })
    expect(decoded.events.map((event) => event.seq)).toEqual([1, 3])
    expect(decoded.unreadable.map((gap) => gap.seq)).toEqual([2])
    expect(decoded.unreadable[0]?.id).toBe(corrupted.id)
  })
})
