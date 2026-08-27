import { afterEach, describe, expect, it } from 'bun:test'

import { ERewindRefusal, toCallId, toRunId, type ThreadId, type EventDraft } from '@dltech/atlas-core'

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
  input: { command: 'rm -rf build' },
  ordinal: 0,
}
const resulted: EventDraft = {
  type: 'tool-result',
  callId: toCallId('call-1'),
  name: 'bash',
  output: { ok: true },
}

const openExchange = async (): Promise<{ fixture: StoreFixture; threadId: ThreadId }> => {
  fixture = await openStoreFixture()
  const thread = await fixture.threads.create({ title: 'work' })
  await fixture.log.append({
    threadId: thread.id,
    runId,
    drafts: [said('clean the build'), replied('on it'), called, resulted, replied('done')],
  })
  return { fixture, threadId: thread.id }
}

afterEach(async () => {
  await fixture.close()
})

describe('rewindThread', () => {
  it('truncates the thread to a settled point and reports what it discarded', async () => {
    const { fixture: store, threadId } = await openExchange()

    const result = await rewindThread({ log: store.log, threads: store.threads, threadId, toSeq: 2 })

    expect(result).toEqual({ ok: true, discarded: 3 })
    expect((await store.log.read({ threadId })).map((event) => event.type)).toEqual([
      'user-said',
      'assistant-said',
    ])
    expect((await store.threads.find({ threadId }))?.head).toBe(2)
  })

  it('refuses a target that would re-dispatch a tool call, which the surviving idempotencyKey does not deduplicate', async () => {
    const { fixture: store, threadId } = await openExchange()

    const result = await rewindThread({ log: store.log, threads: store.threads, threadId, toSeq: 3 })

    expect(result).toMatchObject({ ok: false, refusal: ERewindRefusal.UnsettledToolCall })
    expect((await store.log.read({ threadId })).length).toBe(5)
    expect((await store.threads.find({ threadId }))?.head).toBe(5)
  })

  it('refuses a sequence the thread never reached, and writes nothing', async () => {
    const { fixture: store, threadId } = await openExchange()

    const result = await rewindThread({ log: store.log, threads: store.threads, threadId, toSeq: 9 })

    expect(result).toMatchObject({ ok: false, refusal: ERewindRefusal.NoSuchTarget })
    expect((await store.log.read({ threadId })).length).toBe(5)
    expect((await store.threads.find({ threadId }))?.head).toBe(5)
  })

  it('leaves the thread ready for the next exchange', async () => {
    const { fixture: store, threadId } = await openExchange()

    await rewindThread({ log: store.log, threads: store.threads, threadId, toSeq: 0 })
    const appended = await store.log.append({ threadId, runId, drafts: [said('start over')] })

    expect(appended.map((event) => event.seq)).toEqual([1])
    expect((await store.log.read({ threadId })).map((event) => event.type)).toEqual(['user-said'])
  })
})
