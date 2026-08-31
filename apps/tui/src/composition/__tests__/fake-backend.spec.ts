import { describe, expect, it } from 'bun:test'

import {
  ECompactionAnchor,
  EForkMode,
  toRunId,
  toThreadId,
  type EventDraft,
} from '@dltech/atlas-core'

import { fakeEventLog, fakeThreadStore } from './fake-backend'

const threadId = toThreadId('thread-1')
const runId = toRunId('run-1')
const said = (text: string): EventDraft => ({ type: 'user-said', text })
const five = [said('one'), said('two'), said('three'), said('four'), said('five')]

describe('the fake event log sequences from the head it reserved', () => {
  it('does not hand a summarised thread a sequence it already used', async () => {
    const log = fakeEventLog()
    await log.append({ threadId, runId, drafts: five })
    log.replaceWithSummary({
      threadId,
      anchor: ECompactionAnchor.Prefix,
      fromSeq: 1,
      throughSeq: 3,
      summary: 'the first three',
      discardRows: true,
    })

    const appended = await log.append({ threadId, runId, drafts: [said('after')] })

    expect(appended.at(0)?.seq).toBe(6)
    expect((await log.read({ threadId })).map((event) => event.seq)).toEqual([3, 4, 5, 6])
  })

  it('reports the head it reserved rather than the rows it still holds', async () => {
    const log = fakeEventLog()
    await log.append({ threadId, runId, drafts: five })
    log.replaceWithSummary({
      threadId,
      anchor: ECompactionAnchor.Prefix,
      fromSeq: 1,
      throughSeq: 3,
      summary: 'the first three',
      discardRows: true,
    })

    expect(await log.head({ threadId })).toBe(5)
  })

  it('lets the sequence a truncation freed be taken again', async () => {
    const log = fakeEventLog()
    await log.append({ threadId, runId, drafts: [said('one'), said('two'), said('three')] })

    log.truncate({ threadId, toSeq: 1 })
    const appended = await log.append({ threadId, runId, drafts: [said('two again')] })

    expect(appended.at(0)?.seq).toBe(2)
    expect(await log.head({ threadId })).toBe(2)
  })

  it('stops a read at the sequence it was bounded by', async () => {
    const log = fakeEventLog()
    await log.append({ threadId, runId, drafts: five })

    expect((await log.read({ threadId, upTo: 2 })).map((event) => event.seq)).toEqual([1, 2])
  })
})

describe('the fake event log tells a composed read from an own read', () => {
  it('records an own read without recording a composed one', async () => {
    const log = fakeEventLog()
    await log.append({ threadId, runId, drafts: [said('one')] })

    await log.readOwn({ threadId })

    expect(log.ownReads).toEqual([threadId])
    expect(log.branchesRead).toEqual([])
  })

  it('records a composed read without recording an own one', async () => {
    const log = fakeEventLog()
    await log.append({ threadId, runId, drafts: [said('one')] })

    await log.read({ threadId })

    expect(log.branchesRead).toEqual([threadId])
    expect(log.ownReads).toEqual([])
  })
})

describe('the fake thread store records what a thread was created as', () => {
  it('carries the spawner and the agent type onto the summary', async () => {
    const threads = fakeThreadStore()
    const spawner = await threads.create({})

    const child = await threads.create({ agent: { spawnedBy: spawner.id, type: 'explore' } })

    expect(child.agent).toEqual({ spawnedBy: spawner.id, type: 'explore' })
    expect(await threads.find({ threadId: child.id })).toMatchObject({
      agent: { spawnedBy: spawner.id, type: 'explore' },
    })
  })

  it('leaves a thread nobody spawned without an agent', async () => {
    const threads = fakeThreadStore()

    expect((await threads.create({})).agent).toBeUndefined()
    expect(threads.createdWith).toEqual([{ workspace: null, repo: null }])
  })

  it('names the mode a fork inherited by', async () => {
    const threads = fakeThreadStore({ existing: [threadId] })

    const forked = await threads.fork({ from: threadId, seq: 1, mode: EForkMode.Reference })

    expect(forked.forkMode).toBe(EForkMode.Reference)
  })
})
