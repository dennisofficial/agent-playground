import { afterEach, describe, expect, it } from 'bun:test'

import {
  compactedThrough,
  ECompactionRefusal,
  toCallId,
  toRunId,
  type ThreadId,
  type EventDraft,
} from '@dltech/atlas-core'

import { compactThread, ECompactionFailure, type Summarise } from '../compact'
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

const summarises = (summary: string | null): Summarise => async () => summary

const openThread = async (drafts: readonly EventDraft[]): Promise<ThreadId> => {
  fixture = await openStoreFixture()
  const thread = await fixture.threads.create({ title: 'work' })
  await fixture.log.append({ threadId: thread.id, runId, drafts })
  return thread.id
}

const compactTo = (args: { threadId: ThreadId; throughSeq: number; summary: string | null }) =>
  compactThread({
    log: fixture.log,
    threads: fixture.threads,
    threadId: args.threadId,
    throughSeq: args.throughSeq,
    summarise: summarises(args.summary),
  })

afterEach(async () => {
  await fixture.close()
})

describe('compactThread', () => {
  it('replaces the compacted range with the summary and reports what it swallowed', async () => {
    const threadId = await openThread([
      said('build the parser'),
      replied('done'),
      said('now the lexer'),
    ])

    const outcome = await compactTo({ threadId, throughSeq: 2, summary: 'A parser was written.' })

    expect(outcome).toEqual({
      ok: true,
      throughSeq: 2,
      replaced: 2,
      summary: 'A parser was written.',
    })
  })

  it('leaves the thread holding the summary in place of the turns it compacted', async () => {
    const threadId = await openThread([said('build the parser'), replied('done'), said('next')])

    await compactTo({ threadId, throughSeq: 2, summary: 'A parser was written.' })

    const events = await fixture.log.read({ threadId })
    expect(events.map((event) => [event.seq, event.type])).toEqual([
      [2, 'history-compacted'],
      [3, 'user-said'],
    ])
    expect(compactedThrough(events)).toBe(2)
  })

  it('survives a reload, because the summary is a stored event like any other', async () => {
    const threadId = await openThread([said('build the parser'), replied('done'), said('next')])

    await compactTo({ threadId, throughSeq: 2, summary: 'A parser was written.' })

    const watermark = (await fixture.log.read({ threadId })).find(
      (event) => event.type === 'history-compacted',
    )

    expect(watermark?.type === 'history-compacted' && watermark.summary).toBe('A parser was written.')
    expect(watermark?.type === 'history-compacted' && watermark.replaced).toBe(2)
  })

  it('keeps appending above the summary, so the sequence never collides', async () => {
    const threadId = await openThread([said('build the parser'), replied('done'), said('next')])

    await compactTo({ threadId, throughSeq: 2, summary: 'A parser was written.' })
    const [appended] = await fixture.log.append({
      threadId,
      runId,
      drafts: [said('and now this')],
    })

    expect(appended?.seq).toBe(4)
  })

  it('compacts again over a thread it already compacted, folding the earlier summary in', async () => {
    const threadId = await openThread([said('one'), replied('two'), said('three'), replied('four')])

    await compactTo({ threadId, throughSeq: 2, summary: 'the first exchange' })
    const again = await compactTo({ threadId, throughSeq: 4, summary: 'both exchanges' })

    if (!again.ok) throw new Error(again.reason)
    expect(again.replaced).toBe(3)

    const events = await fixture.log.read({ threadId })
    expect(events.map((event) => event.type)).toEqual(['history-compacted'])
    expect(compactedThrough(events)).toBe(4)
  })

  it('refuses a watermark the guard rejects and leaves the thread untouched', async () => {
    const threadId = await openThread([said('clean the build'), called, resulted])

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

  it('deletes nothing when the summariser fails, rather than compacting to nothing', async () => {
    const threadId = await openThread([said('build the parser'), replied('done'), said('next')])

    const outcome = await compactTo({ threadId, throughSeq: 2, summary: null })

    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.failure).toBe(ECompactionFailure.NoSummary)
    expect((await fixture.log.read({ threadId })).length).toBe(3)
  })

  it('never asks the summariser for a range the guard already refused', async () => {
    const threadId = await openThread([said('clean the build'), called, resulted])
    let asked = false

    await compactThread({
      log: fixture.log,
      threads: fixture.threads,
      threadId,
      throughSeq: 2,
      summarise: async () => {
        asked = true
        return 'a summary'
      },
    })

    expect(asked).toBe(false)
  })
})
