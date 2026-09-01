import { afterEach, describe, expect, it } from 'bun:test'

import { EForkMode, toRunId, toThreadId, type EventDraft } from '@dltech/atlas-core'

import type { PrismaClient } from '../../../prisma/generated/client'
import { ThreadNeedsOpeningDrafts } from '../create-with-events'
import { openStoreFixture, type StoreFixture } from './harness'

let fixture: StoreFixture

const runId = toRunId('run-1')
const said = (text: string): EventDraft => ({ type: 'user-said', text })

const refuseHeadOf = async ({
  prisma,
  head,
}: {
  prisma: PrismaClient
  head: number
}): Promise<void> => {
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER refuse_head AFTER UPDATE OF head ON "Thread" WHEN NEW.head = ${head}
     BEGIN SELECT RAISE(ABORT, 'head refused'); END`,
  )
}

const openFixture = async (): Promise<StoreFixture> => {
  fixture = await openStoreFixture()
  return fixture
}

afterEach(async () => {
  await fixture.close()
})

describe('opening a thread together with its first events', () => {
  it('lands the thread and its opening event in one call', async () => {
    const { threads, log } = await openFixture()

    const { thread, events } = await threads.createWithFirstEvents({
      title: 'read the ledger',
      drafts: [said('start here')],
      runId,
    })

    expect(thread.head).toBe(1)
    expect(events.map((event) => event.seq)).toEqual([1])
    expect(events[0]?.threadId).toBe(thread.id)
    expect((await log.readOwn({ threadId: thread.id })).map((event) => event.type)).toEqual([
      'user-said',
    ])
  })

  it('opens under an id it was handed, so a caller can hold one before there is a thread', async () => {
    const { threads, log } = await openFixture()
    const promised = toThreadId('handed-out-before-anything-was-said')

    const { thread, events } = await threads.createWithFirstEvents({
      threadId: promised,
      drafts: [said('start here')],
      runId,
    })

    expect(thread.id).toBe(promised)
    expect(events[0]?.threadId).toBe(promised)
    expect((await log.readOwn({ threadId: promised })).length).toBe(1)
    expect(await threads.find({ threadId: promised })).toBeDefined()
  })

  it('numbers several opening drafts the way an ordinary append would', async () => {
    const { threads, log } = await openFixture()

    const { thread } = await threads.createWithFirstEvents({
      drafts: [said('one'), said('two'), said('three')],
      runId,
    })

    expect((await log.readOwn({ threadId: thread.id })).map((event) => event.seq)).toEqual([1, 2, 3])
    expect((await threads.find({ threadId: thread.id }))?.head).toBe(3)
  })

  it('leaves no thread behind when the opening event cannot be written', async () => {
    const { threads, prisma } = await openFixture()
    await refuseHeadOf({ prisma, head: 1 })

    await expect(
      threads.createWithFirstEvents({ title: 'doomed', drafts: [said('start here')], runId }),
    ).rejects.toThrow()

    expect(await prisma.thread.count()).toBe(0)
    expect(await prisma.event.count()).toBe(0)
  })

  it('refuses to open a thread with nothing said in it, and creates nothing', async () => {
    const { threads, prisma } = await openFixture()

    await expect(threads.createWithFirstEvents({ drafts: [], runId })).rejects.toThrow(
      ThreadNeedsOpeningDrafts,
    )

    expect(await prisma.thread.count()).toBe(0)
  })

  it('carries the supervision link and the workspace it was given', async () => {
    const { threads } = await openFixture()
    const parent = await threads.create({ workspace: '/work/atlas' })

    const { thread } = await threads.createWithFirstEvents({
      title: 'researcher: read the ledger',
      drafts: [said('the brief')],
      runId,
      workspace: '/work/atlas',
      repo: 'atlas',
      agent: { spawnedBy: parent.id, type: 'researcher' },
    })

    expect(thread.agent).toEqual({ spawnedBy: parent.id, type: 'researcher' })
    expect(thread.workspace).toBe('/work/atlas')
    expect(thread.repo).toBe('atlas')
    expect((await threads.find({ threadId: thread.id }))?.agent?.type).toBe('researcher')
  })

  it('is not readable as a fork of anything', async () => {
    const { threads } = await openFixture()
    const parent = await threads.create({})

    const { thread } = await threads.createWithFirstEvents({
      drafts: [said('the brief')],
      runId,
      agent: { spawnedBy: parent.id, type: 'researcher' },
    })

    expect(thread.parent).toBeUndefined()
    expect(thread.forkMode).toBeUndefined()
  })
})

describe('listing the agents a thread spawned', () => {
  it('lists them oldest first and leaves other threads out', async () => {
    const { threads } = await openFixture()
    const parent = await threads.create({})
    const stranger = await threads.create({})

    const first = await threads.createWithFirstEvents({
      drafts: [said('one')],
      runId,
      agent: { spawnedBy: parent.id, type: 'researcher' },
    })
    const second = await threads.createWithFirstEvents({
      drafts: [said('two')],
      runId,
      agent: { spawnedBy: parent.id, type: 'reviewer' },
    })
    await threads.createWithFirstEvents({
      drafts: [said('elsewhere')],
      runId,
      agent: { spawnedBy: stranger.id, type: 'researcher' },
    })

    expect((await threads.spawned({ threadId: parent.id })).map((row) => row.id)).toEqual([
      first.thread.id,
      second.thread.id,
    ])
  })

  it('does not mistake a fork of the thread for an agent it spawned', async () => {
    const { threads } = await openFixture()
    const parent = await threads.create({})
    await threads.fork({ from: parent.id, seq: 0, mode: EForkMode.Reference })

    expect(await threads.spawned({ threadId: parent.id })).toEqual([])
  })

  it('finds a child the parent log never recorded, which is the orphan case', async () => {
    const { threads, log } = await openFixture()
    const parent = await threads.create({})
    const { thread: child } = await threads.createWithFirstEvents({
      drafts: [said('the brief')],
      runId,
      agent: { spawnedBy: parent.id, type: 'researcher' },
    })

    const spawnedRows = (await log.readOwn({ threadId: parent.id })).filter(
      (event) => event.type === 'agent-spawned',
    )

    expect(spawnedRows).toEqual([])
    expect((await threads.spawned({ threadId: parent.id })).map((row) => row.id)).toEqual([child.id])
  })

  it('answers with nothing for a thread that never spawned anyone', async () => {
    const { threads } = await openFixture()
    const lonely = await threads.create({})

    expect(await threads.spawned({ threadId: lonely.id })).toEqual([])
    expect(await threads.spawned({ threadId: toThreadId('never-existed') })).toEqual([])
  })
})
