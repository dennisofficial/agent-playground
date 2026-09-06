import { afterEach, describe, expect, it } from 'bun:test'

import {
  compactedThrough,
  eventBodySchema,
  ECompactionAnchor,
  ECompactionRefusal,
  ERewindRefusal,
  toCallId,
  toRunId,
  type EventDraft,
  type ThreadId,
} from '@dltech/atlas-core'

import { compactThread, ECompactionFailure, type Summarise } from '../compact'
import { rewindThread } from '../rewind'
import { openStoreFixture, type StoreFixture } from './harness'

let fixture: StoreFixture

const runId = toRunId('run-1')

const said = (text: string): EventDraft => ({ type: 'user-said', text })
const replied = (text: string): EventDraft => ({
  type: 'assistant-said',
  parts: [{ type: 'text', text }],
})
const called: EventDraft = {
  type: 'tool-called',
  callId: toCallId('call-1'),
  name: 'bash',
  input: { command: 'ls' },
  ordinal: 0,
}
const resulted: EventDraft = {
  type: 'tool-result',
  callId: toCallId('call-1'),
  name: 'bash',
  output: { ok: true },
}

const granted: EventDraft = eventBodySchema.parse({
  type: 'permission-granted',
  grantId: 'grant-1',
  dimensions: ['contention'],
  scope: 'thread',
  subject: 'worktree:eng-412-sidebar',
  reason: 'the operator chose to stop being asked about this',
})

const revoked: EventDraft = eventBodySchema.parse({
  type: 'permission-revoked',
  grantId: 'grant-1',
})

const summarises = (summary: string | null): Summarise => async () => summary

const openThread = async (drafts: readonly EventDraft[]): Promise<ThreadId> => {
  fixture = await openStoreFixture()
  const thread = await fixture.threads.create({ title: 'work' })
  await fixture.log.append({ threadId: thread.id, runId, drafts })
  return thread.id
}

const mark = (args: {
  threadId: ThreadId
  anchor?: ECompactionAnchor
  seq: number
  summary: string | null
  destructive: boolean
}) =>
  compactThread({
    log: fixture.log,
    threads: fixture.threads,
    agents: fixture.agents,
    threadId: args.threadId,
    anchor: args.anchor ?? ECompactionAnchor.Prefix,
    seq: args.seq,
    destructive: args.destructive,
    summarise: summarises(args.summary),
  })

const compactTo = (args: { threadId: ThreadId; throughSeq: number; summary: string | null }) =>
  mark({ threadId: args.threadId, seq: args.throughSeq, summary: args.summary, destructive: false })

const summariseTo = (args: { threadId: ThreadId; throughSeq: number; summary: string | null }) =>
  mark({ threadId: args.threadId, seq: args.throughSeq, summary: args.summary, destructive: true })

const summariseFrom = (args: { threadId: ThreadId; fromSeq: number; summary: string | null }) =>
  mark({
    threadId: args.threadId,
    anchor: ECompactionAnchor.Suffix,
    seq: args.fromSeq,
    summary: args.summary,
    destructive: true,
  })

const shapeOf = async (threadId: ThreadId) =>
  (await fixture.log.read({ threadId })).map((event) => [event.seq, event.type])

const rewoundTo = (args: { threadId: ThreadId; toSeq: number }) =>
  rewindThread({
    log: fixture.log,
    threads: fixture.threads,
    agents: fixture.agents,
    threadId: args.threadId,
    toSeq: args.toSeq,
  })

const OPENING = [said('one'), replied('two'), said('three'), replied('four')] as const

afterEach(async () => {
  await fixture.close()
})

describe('compaction hides a range without destroying it', () => {
  it('appends the watermark past the head and leaves every row where it was', async () => {
    const threadId = await openThread([...OPENING])

    const outcome = await compactTo({ threadId, throughSeq: 2, summary: 'the opening' })

    expect(outcome).toEqual({
      ok: true,
      anchor: ECompactionAnchor.Prefix,
      fromSeq: 1,
      throughSeq: 2,
      replaced: 2,
      summary: 'the opening',
    })
    expect(await shapeOf(threadId)).toEqual([
      [1, 'user-said'],
      [2, 'assistant-said'],
      [3, 'user-said'],
      [4, 'assistant-said'],
      [5, 'history-compacted'],
    ])
  })

  it('leaves the boundary rewindable, because nothing was lost', async () => {
    const threadId = await openThread([...OPENING])
    await compactTo({ threadId, throughSeq: 2, summary: 'the opening' })

    const rewound = await rewoundTo({ threadId, toSeq: 1 })

    expect(rewound.ok).toBe(true)
    expect((await fixture.log.read({ threadId })).map((event) => event.seq)).toEqual([1])
  })

  it('keeps appending above the watermark', async () => {
    const threadId = await openThread([...OPENING])
    await compactTo({ threadId, throughSeq: 2, summary: 'the opening' })

    const [appended] = await fixture.log.append({ threadId, runId, drafts: [said('five')] })

    expect(appended?.seq).toBe(6)
  })

  it('survives a reload, because the watermark is a stored event like any other', async () => {
    const threadId = await openThread([...OPENING])
    await compactTo({ threadId, throughSeq: 2, summary: 'the opening' })

    const events = await fixture.log.read({ threadId })
    const watermark = events.find((event) => event.type === 'history-compacted')

    expect(watermark?.type === 'history-compacted' && watermark.summary).toBe('the opening')
    expect(watermark?.type === 'history-compacted' && watermark.replaced).toBe(2)
    expect(compactedThrough(events)).toBe(2)
  })
})

describe('summarisation replaces the range it covers', () => {
  it('deletes the rows and stands the summary in their place', async () => {
    const threadId = await openThread([...OPENING])

    await summariseTo({ threadId, throughSeq: 2, summary: 'the opening' })

    expect(await shapeOf(threadId)).toEqual([
      [2, 'history-compacted'],
      [3, 'user-said'],
      [4, 'assistant-said'],
    ])
  })

  it('closes the boundary to rewind, because there is nothing behind it', async () => {
    const threadId = await openThread([...OPENING])
    await summariseTo({ threadId, throughSeq: 2, summary: 'the opening' })

    const rewound = await rewoundTo({ threadId, toSeq: 1 })

    expect(rewound.ok).toBe(false)
    expect(rewound.ok === false && rewound.refusal).toBe(ERewindRefusal.BelowCompaction)
  })

  it('still allows a rewind above the boundary', async () => {
    const threadId = await openThread([...OPENING])
    await summariseTo({ threadId, throughSeq: 2, summary: 'the opening' })

    expect(await rewoundTo({ threadId, toSeq: 3 })).toEqual({ ok: true, discarded: 1 })
  })

  it('folds an earlier summary into a later one', async () => {
    const threadId = await openThread([...OPENING])

    await summariseTo({ threadId, throughSeq: 2, summary: 'the opening' })
    const again = await summariseTo({ threadId, throughSeq: 4, summary: 'both exchanges' })

    if (!again.ok) throw new Error(again.reason)
    expect(await shapeOf(threadId)).toEqual([[4, 'history-compacted']])
  })

  it('replaces the tail instead when asked to summarise from a point', async () => {
    const threadId = await openThread([...OPENING])

    await summariseFrom({ threadId, fromSeq: 3, summary: 'the closing' })

    expect(await shapeOf(threadId)).toEqual([
      [1, 'user-said'],
      [2, 'assistant-said'],
      [3, 'history-compacted'],
    ])
  })

  it('does not raise the rewind floor when it took only the tail', async () => {
    const threadId = await openThread([...OPENING])
    await summariseFrom({ threadId, fromSeq: 3, summary: 'the closing' })

    expect((await rewoundTo({ threadId, toSeq: 1 })).ok).toBe(true)
  })
})

describe('what neither operation will do', () => {
  it('refuses a prefix that would orphan a tool result', async () => {
    const threadId = await openThread([said('clean it'), called, resulted])

    const outcome = await compactTo({ threadId, throughSeq: 2, summary: 'never asked for' })

    expect(outcome).toEqual({
      ok: false,
      failure: ECompactionFailure.Refused,
      reason:
        'compacting through 2 would keep the result of bash (call-1) after compacting the call it answers',
      refusal: ECompactionRefusal.SplitsToolCall,
    })
    expect((await fixture.log.read({ threadId })).length).toBe(3)
  })

  it('refuses a suffix that would strand a dispatched call', async () => {
    const threadId = await openThread([said('clean it'), called, resulted, replied('done')])

    const outcome = await summariseFrom({ threadId, fromSeq: 3, summary: 'never asked for' })

    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.refusal).toBe(ECompactionRefusal.SplitsToolCall)
    expect((await fixture.log.read({ threadId })).length).toBe(4)
  })

  it('changes nothing when the summariser comes back empty', async () => {
    const threadId = await openThread([...OPENING])

    const outcome = await compactTo({ threadId, throughSeq: 2, summary: null })

    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.failure).toBe(ECompactionFailure.NoSummary)
    expect((await fixture.log.read({ threadId })).length).toBe(4)
  })

  it('never asks the summariser for a range the guard already refused', async () => {
    const threadId = await openThread([said('clean it'), called, resulted])
    let asked = false

    await compactThread({
      log: fixture.log,
      threads: fixture.threads,
      agents: fixture.agents,
      threadId,
      anchor: ECompactionAnchor.Prefix,
      seq: 2,
      summarise: async () => {
        asked = true
        return 'a summary'
      },
    })

    expect(asked).toBe(false)
  })

  it('spares a grant from a destructive summary and takes the turn beside it', async () => {
    const threadId = await openThread([said('clean it'), granted, said('and again'), replied('done')])

    const outcome = await summariseTo({ threadId, throughSeq: 3, summary: 'the cleanup' })

    expect(outcome.ok).toBe(true)
    expect(await shapeOf(threadId)).toEqual([
      [2, 'permission-granted'],
      [3, 'history-compacted'],
      [4, 'assistant-said'],
    ])
  })

  it('stands the summary in a seat the range actually vacated, not on a row it spared', async () => {
    const threadId = await openThread([said('clean it'), granted, revoked, replied('done')])

    await summariseTo({ threadId, throughSeq: 3, summary: 'the cleanup' })

    expect(await shapeOf(threadId)).toEqual([
      [1, 'history-compacted'],
      [2, 'permission-granted'],
      [3, 'permission-revoked'],
      [4, 'assistant-said'],
    ])
  })

  it('counts only the rows it actually replaced, not the grant it spared', async () => {
    const threadId = await openThread([said('clean it'), granted, said('and again'), replied('done')])

    const outcome = await summariseTo({ threadId, throughSeq: 3, summary: 'the cleanup' })

    expect(outcome.ok === true && outcome.replaced).toBe(2)
  })
})
