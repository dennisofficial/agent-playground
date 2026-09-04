import { afterEach, describe, expect, it } from 'bun:test'

import {
  ECompactionAnchor,
  EExecutionLocation,
  EForkMode,
  toRunId,
  type EventDraft,
  type ThreadId,
} from '@dltech/atlas-core'

import { openStoreFixture, type StoreFixture } from './harness'

let fixture: StoreFixture

const runId = toRunId('run-1')
const said = (text: string): EventDraft => ({ type: 'user-said', text })

const openThread = async (): Promise<ThreadId> => {
  fixture = await openStoreFixture()
  const thread = await fixture.threads.create({ title: 'work' })
  await fixture.log.append({
    threadId: thread.id,
    runId,
    drafts: [said('one'), said('two'), said('three')],
  })
  return thread.id
}

const locationOf = async (threadId: ThreadId): Promise<EExecutionLocation | undefined> =>
  (await fixture.threads.find({ threadId }))?.executionLocation

afterEach(async () => {
  await fixture.close()
})

describe('the execution location of a thread', () => {
  it('stays undecided until the operator switches it', async () => {
    const threadId = await openThread()

    expect(await locationOf(threadId)).toBeUndefined()
  })

  it('is written by choosing one and read back on the summary', async () => {
    const threadId = await openThread()

    await fixture.threads.chooseExecutionLocation({
      threadId,
      location: EExecutionLocation.Docker,
    })

    expect(await locationOf(threadId)).toBe(EExecutionLocation.Docker)
  })

  it('is written over by the next switch, not stacked', async () => {
    const threadId = await openThread()

    await fixture.threads.chooseExecutionLocation({
      threadId,
      location: EExecutionLocation.Docker,
    })
    await fixture.threads.chooseExecutionLocation({ threadId, location: EExecutionLocation.Host })

    expect(await locationOf(threadId)).toBe(EExecutionLocation.Host)
  })

  it('survives a rewind below the switch, because the mode is not log history', async () => {
    const threadId = await openThread()
    await fixture.threads.chooseExecutionLocation({
      threadId,
      location: EExecutionLocation.Docker,
    })

    await fixture.threads.rewind({ threadId, toSeq: 1 })

    expect(await locationOf(threadId)).toBe(EExecutionLocation.Docker)
    expect((await fixture.threads.find({ threadId }))?.head).toBe(1)
  })

  it('survives compaction for the same reason', async () => {
    const threadId = await openThread()
    await fixture.threads.chooseExecutionLocation({
      threadId,
      location: EExecutionLocation.Docker,
    })

    await fixture.threads.compact({
      threadId,
      anchor: ECompactionAnchor.Prefix,
      fromSeq: 1,
      throughSeq: 2,
      summary: 'the beginning, shorter',
    })

    expect(await locationOf(threadId)).toBe(EExecutionLocation.Docker)
  })

  it('is carried forward by a fork, the way the model pair is', async () => {
    const threadId = await openThread()
    await fixture.threads.chooseExecutionLocation({
      threadId,
      location: EExecutionLocation.Docker,
    })

    const child = await fixture.threads.fork({ from: threadId, seq: 2, mode: EForkMode.Copy })

    expect(child.executionLocation).toBe(EExecutionLocation.Docker)
    expect(await locationOf(child.id)).toBe(EExecutionLocation.Docker)
    expect(await locationOf(threadId)).toBe(EExecutionLocation.Docker)
  })

  it('leaves a fork of an undecided thread undecided, so the default still answers', async () => {
    const threadId = await openThread()

    const child = await fixture.threads.fork({ from: threadId, seq: 2, mode: EForkMode.Reference })

    expect(child.executionLocation).toBeUndefined()
  })
})
