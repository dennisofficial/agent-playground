import { afterEach, describe, expect, it } from 'bun:test'

import { EForkMode, toRunId, type EventDraft } from '@dltech/atlas-core'

import type { PrismaClient } from '../../../prisma/generated/client'
import { openStoreFixture, type StoreFixture } from './harness'

let fixture: StoreFixture

const runId = toRunId('run-1')
const said = (text: string): EventDraft => ({ type: 'user-said', text })

const deleteThread = async ({
  prisma,
  id,
}: {
  prisma: PrismaClient
  id: string
}): Promise<void> => {
  await prisma.thread.delete({ where: { id } })
}

const openFixture = async (): Promise<StoreFixture> => {
  fixture = await openStoreFixture()
  return fixture
}

afterEach(async () => {
  await fixture.close()
})

describe('a thread that a sub-agent runs in', () => {
  it('records the thread that spawned it and the type it runs as', async () => {
    const { threads } = await openFixture()
    const spawner = await threads.create({ title: 'main', workspace: '/here' })

    const child = await threads.create({
      workspace: '/here',
      agent: { spawnedBy: spawner.id, type: 'explore' },
    })

    expect(child.agent).toEqual({ spawnedBy: spawner.id, type: 'explore' })
  })

  it('reads the spawner and the type back off a summary loaded from the row', async () => {
    const { threads } = await openFixture()
    const spawner = await threads.create({ title: 'main', workspace: '/here' })
    const child = await threads.create({
      workspace: '/here',
      agent: { spawnedBy: spawner.id, type: 'reviewer' },
    })

    expect((await threads.find({ threadId: child.id }))?.agent).toEqual({
      spawnedBy: spawner.id,
      type: 'reviewer',
    })
    expect(
      (await threads.list({ project: '/here' })).find((row) => row.id === child.id)?.agent,
    ).toEqual({ spawnedBy: spawner.id, type: 'reviewer' })
  })

  it('claims no agent for a thread a human opened', async () => {
    const { threads } = await openFixture()

    const thread = await threads.create({ title: 'mine', workspace: '/here' })

    expect(thread.agent).toBeUndefined()
    expect((await threads.find({ threadId: thread.id }))?.agent).toBeUndefined()
  })

  it('does not read a fork as a spawned agent', async () => {
    const { threads, log } = await openFixture()
    const source = await threads.create({ workspace: '/here' })
    await log.append({ threadId: source.id, runId, drafts: [said('one')] })

    const forked = await threads.fork({ from: source.id, seq: 1, mode: EForkMode.Copy })

    expect(forked.agent).toBeUndefined()
    expect((await threads.find({ threadId: forked.id }))?.agent).toBeUndefined()
  })
})

describe('a summary that names the mode a child inherited by', () => {
  it('tells a reference child from a copy child', async () => {
    const { threads, log } = await openFixture()
    const source = await threads.create({ workspace: '/here' })
    await log.append({ threadId: source.id, runId, drafts: [said('one')] })

    const referenced = await threads.fork({ from: source.id, seq: 1, mode: EForkMode.Reference })
    const copied = await threads.fork({ from: source.id, seq: 1, mode: EForkMode.Copy })

    expect(referenced.forkMode).toBe(EForkMode.Reference)
    expect(copied.forkMode).toBe(EForkMode.Copy)
    expect((await threads.find({ threadId: referenced.id }))?.forkMode).toBe(EForkMode.Reference)
  })

  it('claims no mode for a thread that was never forked', async () => {
    const { threads } = await openFixture()

    expect((await threads.create({ workspace: '/here' })).forkMode).toBeUndefined()
  })
})

describe('deleting a thread other threads descend from', () => {
  it('deletes a thread nothing descends from', async () => {
    const { threads, prisma, log } = await openFixture()
    const thread = await threads.create({ workspace: '/here' })
    await log.append({ threadId: thread.id, runId, drafts: [said('one')] })

    await deleteThread({ prisma, id: thread.id })

    expect(await threads.find({ threadId: thread.id })).toBeUndefined()
  })

  it('refuses to delete a thread that spawned an agent', async () => {
    const { threads, prisma } = await openFixture()
    const spawner = await threads.create({ workspace: '/here' })
    await threads.create({ workspace: '/here', agent: { spawnedBy: spawner.id, type: 'explore' } })

    await expect(deleteThread({ prisma, id: spawner.id })).rejects.toThrow()

    expect(await threads.find({ threadId: spawner.id })).toBeDefined()
  })

  it('refuses to delete a thread that was forked from', async () => {
    const { threads, prisma, log } = await openFixture()
    const source = await threads.create({ workspace: '/here' })
    await log.append({ threadId: source.id, runId, drafts: [said('one')] })
    await threads.fork({ from: source.id, seq: 1, mode: EForkMode.Reference })

    await expect(deleteThread({ prisma, id: source.id })).rejects.toThrow()

    expect(await threads.find({ threadId: source.id })).toBeDefined()
  })
})
