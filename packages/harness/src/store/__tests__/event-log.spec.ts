import { afterEach, describe, expect, it } from 'bun:test'

import {
  EDecision,
  toBranchId,
  toCallId,
  toRunId,
  type Event,
  type EventDraft,
} from '@dltech/atlas-core'

import { EUnreadableReason } from '../decode-events'
import { openSecondWriter, openStoreFixture, type StoreFixture } from './harness'

let fixture: StoreFixture

const branchId = toBranchId('branch-1')
const runId = toRunId('run-1')

const said = (text: string): EventDraft => ({ type: 'user-said', text })

const openFixture = async (): Promise<StoreFixture> => {
  fixture = await openStoreFixture()
  return fixture
}

afterEach(async () => {
  await fixture.close()
})

describe('PrismaEventLog append', () => {
  it('stamps several drafts at once, in order, from seq 1', async () => {
    const { log } = await openFixture()

    const appended = await log.append({ branchId, runId, drafts: [said('one'), said('two'), said('three')] })

    expect(appended.map((event) => event.seq)).toEqual([1, 2, 3])
    expect(appended.map((event) => event.type === 'user-said' && event.text)).toEqual(['one', 'two', 'three'])
    expect(new Set(appended.map((event) => event.id)).size).toBe(3)
    expect(appended.every((event) => event.branchId === branchId && event.runId === runId)).toBe(true)
  })

  it('continues the sequence across separate appends', async () => {
    const { log } = await openFixture()

    await log.append({ branchId, runId, drafts: [said('one')] })
    const second = await log.append({ branchId, runId, drafts: [said('two'), said('three')] })

    expect(second.map((event) => event.seq)).toEqual([2, 3])
  })

  it('keeps sequences independent per branch', async () => {
    const { log } = await openFixture()
    const other = toBranchId('branch-2')

    await log.append({ branchId, runId, drafts: [said('one'), said('two')] })
    const appended = await log.append({ branchId: other, runId, drafts: [said('elsewhere')] })

    expect(appended[0]?.seq).toBe(1)
  })

  it('returns nothing for an empty batch', async () => {
    const { log } = await openFixture()

    expect(await log.append({ branchId, runId, drafts: [] })).toEqual([])
    expect(await log.head({ branchId })).toBe(0)
  })

  it('records depth 0 and no parent run at a root run', async () => {
    const { log } = await openFixture()

    const [event] = await log.append({ branchId, runId, drafts: [said('one')] })

    expect(event?.depth).toBe(0)
    expect(event?.parentRunId).toBeUndefined()
  })

  it('stores parentRunId and depth as recoverable envelope fields', async () => {
    const { log } = await openFixture()
    const parentRunId = toRunId('run-parent')

    await log.append({ branchId, runId, drafts: [said('nested')], parentRunId, depth: 2 })
    const [event] = await log.read({ branchId })

    expect(event?.depth).toBe(2)
    expect(event?.parentRunId).toBe(parentRunId)
  })
})

describe('PrismaEventLog read', () => {
  it('reads a branch back in sequence order', async () => {
    const { log } = await openFixture()

    await log.append({ branchId, runId, drafts: [said('one')] })
    await log.append({ branchId, runId, drafts: [said('two'), said('three')] })

    expect((await log.read({ branchId })).map((event) => event.seq)).toEqual([1, 2, 3])
  })

  it('reads only a prefix when given an upper bound', async () => {
    const { log } = await openFixture()

    await log.append({ branchId, runId, drafts: [said('one'), said('two'), said('three')] })

    expect((await log.read({ branchId, upTo: 2 })).map((event) => event.seq)).toEqual([1, 2])
    expect(await log.read({ branchId, upTo: 0 })).toEqual([])
  })

  it('reads nothing for a branch that was never written', async () => {
    const { log } = await openFixture()

    expect(await log.read({ branchId: toBranchId('never') })).toEqual([])
  })

  it('excludes other branches', async () => {
    const { log } = await openFixture()

    await log.append({ branchId, runId, drafts: [said('mine')] })
    await log.append({ branchId: toBranchId('branch-2'), runId, drafts: [said('theirs')] })

    const read = await log.read({ branchId })
    expect(read).toHaveLength(1)
    expect(read[0]?.type === 'user-said' && read[0].text).toBe('mine')
  })
})

describe('PrismaEventLog head', () => {
  it('is zero for an unknown branch', async () => {
    const { log } = await openFixture()

    expect(await log.head({ branchId: toBranchId('unknown') })).toBe(0)
  })

  it('tracks the last assigned sequence number', async () => {
    const { log } = await openFixture()

    await log.append({ branchId, runId, drafts: [said('one'), said('two')] })
    expect(await log.head({ branchId })).toBe(2)

    await log.append({ branchId, runId, drafts: [said('three')] })
    expect(await log.head({ branchId })).toBe(3)
  })
})

describe('PrismaEventLog hydration', () => {
  const roundTrip = async (draft: EventDraft): Promise<Event> => {
    const { log } = await openFixture()
    await log.append({ branchId, runId, drafts: [draft] })
    const [event] = await log.read({ branchId })
    if (!event) throw new Error('nothing was stored')
    return event
  }

  it('carries a reasoning signature through providerOptions untouched', async () => {
    const event = await roundTrip({
      type: 'assistant-said',
      parts: [
        { type: 'reasoning', text: 'thinking', providerOptions: { anthropic: { signature: 'sig-abc' } } },
        { type: 'text', text: 'answer' },
      ],
    })

    if (event.type !== 'assistant-said') throw new Error('wrong event type')
    expect(event.parts[0]).toEqual({
      type: 'reasoning',
      text: 'thinking',
      providerOptions: { anthropic: { signature: 'sig-abc' } },
    })
    expect(event.parts[1]).toEqual({ type: 'text', text: 'answer' })
  })

  it('preserves an interrupted assistant turn', async () => {
    const event = await roundTrip({
      type: 'assistant-said',
      parts: [{ type: 'text', text: 'partial' }],
      interrupted: true,
    })

    expect(event.type === 'assistant-said' && event.interrupted).toBe(true)
  })

  it('stores a tool call with its ordinal', async () => {
    const event = await roundTrip({
      type: 'tool-called',
      callId: toCallId('call-1'),
      name: 'read',
      input: { path: '/tmp/x', nested: [1, 2, { deep: true }] },
      ordinal: 3,
    })

    expect(event).toMatchObject({
      type: 'tool-called',
      name: 'read',
      ordinal: 3,
      input: { path: '/tmp/x', nested: [1, 2, { deep: true }] },
    })
  })

  it('distinguishes a crashed tool result from a denial', async () => {
    const crashed = await roundTrip({
      type: 'tool-result',
      callId: toCallId('call-1'),
      name: 'read',
      output: null,
      error: { message: 'ENOENT' },
    })
    expect(crashed.type === 'tool-result' && crashed.error).toEqual({ message: 'ENOENT' })

    const denied = await roundTrip({
      type: 'tool-denied',
      callId: toCallId('call-1'),
      name: 'write',
      reason: 'policy',
    })
    expect(denied).toMatchObject({ type: 'tool-denied', name: 'write', reason: 'policy' })
  })

  it('stores every remaining kind in the union', async () => {
    expect(
      await roundTrip({ type: 'approval-requested', callId: toCallId('call-1'), reason: 'destructive' }),
    ).toMatchObject({ type: 'approval-requested', reason: 'destructive' })

    expect(
      await roundTrip({
        type: 'approval-answered',
        callId: toCallId('call-1'),
        decision: EDecision.Allow,
        editedInput: { path: '/tmp/y' },
      }),
    ).toMatchObject({ type: 'approval-answered', decision: EDecision.Allow, editedInput: { path: '/tmp/y' } })

    expect(
      await roundTrip({ type: 'nudge', text: 'stay on task', lifetimeSteps: 2 }),
    ).toMatchObject({ type: 'nudge', text: 'stay on task', lifetimeSteps: 2 })

    expect(
      await roundTrip({
        type: 'context-loaded',
        slot: 'project-instructions',
        key: '/repo/CLAUDE.md',
        content: '# rules',
        triggeredBy: 'read',
      }),
    ).toMatchObject({ type: 'context-loaded', slot: 'project-instructions', key: '/repo/CLAUDE.md' })
  })

  it('sets aside a stored body that no longer parses as an event', async () => {
    const { log, databaseUrl } = await openFixture()
    await log.append({ branchId, runId, drafts: [said('one')] })

    const { Database } = await import('bun:sqlite')
    const database = new Database(databaseUrl.replace(/^file:/, ''))
    database.run(`UPDATE "Event" SET "body" = '{"type":"who-knows"}'`)
    database.close()

    expect(await log.read({ branchId })).toEqual([])

    const { unreadable } = await log.readDecoded({ branchId })
    expect(unreadable.map((gap) => gap.seq)).toEqual([1])
    expect(unreadable[0]?.reason).toBe(EUnreadableReason.UnrecognizedBody)
  })
})

describe('PrismaEventLog context-loaded idempotency', () => {
  const loaded = (key: string, content = 'body'): EventDraft => ({
    type: 'context-loaded',
    slot: 'project-instructions',
    key,
    content,
  })

  it('returns the existing event instead of appending a second time', async () => {
    const { log } = await openFixture()

    const [first] = await log.append({ branchId, runId, drafts: [loaded('/repo/CLAUDE.md')] })
    const [second] = await log.append({ branchId, runId, drafts: [loaded('/repo/CLAUDE.md', 'changed')] })

    expect(second?.id).toBe(first?.id)
    expect(second?.seq).toBe(1)
    expect(await log.head({ branchId })).toBe(1)
    expect(await log.read({ branchId })).toHaveLength(1)
  })

  it('collapses duplicates inside one batch', async () => {
    const { log } = await openFixture()

    const appended = await log.append({
      branchId,
      runId,
      drafts: [loaded('/repo/CLAUDE.md'), said('hello'), loaded('/repo/CLAUDE.md')],
    })

    expect(appended).toHaveLength(3)
    expect(appended[0]?.id).toBe(appended[2]?.id)
    expect(await log.read({ branchId })).toHaveLength(2)
  })

  it('keeps distinct keys, distinct slots and distinct branches apart', async () => {
    const { log } = await openFixture()

    await log.append({
      branchId,
      runId,
      drafts: [
        loaded('/repo/CLAUDE.md'),
        loaded('/repo/pkg/CLAUDE.md'),
        { type: 'context-loaded', slot: 'skill', key: '/repo/CLAUDE.md', content: 'other slot' },
      ],
    })
    await log.append({ branchId: toBranchId('branch-2'), runId, drafts: [loaded('/repo/CLAUDE.md')] })

    expect(await log.read({ branchId })).toHaveLength(3)
    expect(await log.read({ branchId: toBranchId('branch-2') })).toHaveLength(1)
  })

  it('does not constrain event kinds that carry no slot and key', async () => {
    const { log } = await openFixture()

    await log.append({ branchId, runId, drafts: [said('one'), said('two'), said('three'), said('four')] })

    expect(await log.read({ branchId })).toHaveLength(4)
  })
})

describe('PrismaEventLog fork', () => {
  it('is present on the interface and unimplemented', async () => {
    const { log } = await openFixture()

    await expect(
      log.forkFrom({ branchId, seq: 1, into: toBranchId('branch-2') }),
    ).rejects.toThrow(/not implemented/i)
  })
})

describe('PrismaEventLog durability', () => {
  it('is readable from a log built fresh from the same file', async () => {
    const first = await openFixture()
    await first.log.append({ branchId, runId, drafts: [said('one'), said('two')] })

    fixture = await first.reopen()

    expect((await fixture.log.read({ branchId })).map((event) => event.seq)).toEqual([1, 2])
    expect(await fixture.log.head({ branchId })).toBe(2)

    const [continued] = await fixture.log.append({ branchId, runId, drafts: [said('three')] })
    expect(continued?.seq).toBe(3)
  })
})

describe('PrismaEventLog concurrency', () => {
  it('gives two concurrent appends on one branch distinct sequence numbers', async () => {
    const { log } = await openFixture()

    const [left, right] = await Promise.all([
      log.append({ branchId, runId, drafts: [said('left')] }),
      log.append({ branchId, runId, drafts: [said('right')] }),
    ])

    expect(new Set([left[0]?.seq, right[0]?.seq])).toEqual(new Set([1, 2]))
    const stored = await log.read({ branchId })
    expect(stored.map((event) => event.seq)).toEqual([1, 2])
    expect(new Set(stored.map((event) => event.type === 'user-said' && event.text))).toEqual(
      new Set(['left', 'right']),
    )
  })

  it('gives two separate writers on one file distinct sequence numbers', async () => {
    const { log } = await openFixture()
    const second = await openSecondWriter(fixture)

    try {
      const [left, right] = await Promise.all([
        log.append({ branchId, runId, drafts: [said('left'), said('left-again')] }),
        second.log.append({ branchId, runId, drafts: [said('right')] }),
      ])

      const seqs = [...left, ...right].map((event) => event.seq).sort((a, b) => a - b)
      expect(seqs).toEqual([1, 2, 3])
      expect((await log.read({ branchId })).map((event) => event.seq)).toEqual([1, 2, 3])
    } finally {
      await second.close()
    }
  })

  it('never lets a batch land with a gap in the middle of another batch', async () => {
    const { log } = await openFixture()

    const batches = await Promise.all(
      Array.from({ length: 6 }, (_unused, index) =>
        log.append({ branchId, runId, drafts: [said(`${index}-a`), said(`${index}-b`)] }),
      ),
    )

    for (const batch of batches) {
      expect(batch).toHaveLength(2)
      expect(batch[1]?.seq).toBe((batch[0]?.seq ?? 0) + 1)
    }
    expect((await log.read({ branchId })).map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  })
})
