import { afterEach, describe, expect, it } from 'bun:test'

import { toBranchId, toRunId, type EventDraft } from '@dltech/atlas-core'

import type { PrismaClient } from '../../../prisma/generated/client'
import { openSecondWriter, openStoreFixture, type StoreFixture } from './harness'

let fixture: StoreFixture

const runId = toRunId('run-1')
const said = (text: string): EventDraft => ({ type: 'user-said', text })

const refuseHeadOf = async ({ prisma, head }: { prisma: PrismaClient; head: number }): Promise<void> => {
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER refuse_head AFTER UPDATE OF head ON "Branch" WHEN NEW.head = ${head}
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

describe('PrismaBranchStore', () => {
  it('creates a branch with a title and an empty head', async () => {
    const { branches } = await openFixture()

    const branch = await branches.create({ title: 'refactor the log' })

    expect(branch.title).toBe('refactor the log')
    expect(branch.head).toBe(0)
    expect(await branches.find({ branchId: branch.id })).toEqual(branch)
  })

  it('has no most recent branch before anything is written', async () => {
    const { branches } = await openFixture()

    expect(await branches.mostRecent()).toBeUndefined()
  })

  it('answers most recent with a query rather than a scan of events', async () => {
    const { branches, log } = await openFixture()

    const older = await branches.create({ title: 'older' })
    const newer = await branches.create({ title: 'newer' })
    await log.append({ branchId: older.id, runId, drafts: [said('touched last')] })

    const recent = await branches.mostRecent()
    expect(recent?.id).toBe(older.id)
    expect(recent?.head).toBe(1)
    expect(newer.id).not.toBe(older.id)
  })

  it('tracks the head of the branch it is asked about', async () => {
    const { branches, log } = await openFixture()

    const branch = await branches.create({ title: 'work' })
    await log.append({ branchId: branch.id, runId, drafts: [said('one'), said('two')] })

    expect((await branches.find({ branchId: branch.id }))?.head).toBe(2)
  })

  it('discovers a branch that only ever appeared in an append', async () => {
    const { branches, log } = await openFixture()
    const branchId = toBranchId('implicit')

    await log.append({ branchId, runId, drafts: [said('hello')] })

    const found = await branches.find({ branchId })
    expect(found?.id).toBe(branchId)
    expect(found?.head).toBe(1)
    expect(found?.title).toBeUndefined()
    expect((await branches.mostRecent())?.id).toBe(branchId)
  })

  it('renames a branch without disturbing its head', async () => {
    const { branches, log } = await openFixture()
    const branchId = toBranchId('implicit')
    await log.append({ branchId, runId, drafts: [said('hello')] })

    await branches.rename({ branchId, title: 'named later' })

    expect(await branches.find({ branchId })).toMatchObject({ title: 'named later', head: 1 })
  })

  it('finds nothing for a branch that does not exist', async () => {
    const { branches } = await openFixture()

    expect(await branches.find({ branchId: toBranchId('nope') })).toBeUndefined()
  })
})

describe('PrismaBranchStore.rewind', () => {
  it('drops the event suffix and moves the head back', async () => {
    const { branches, log } = await openFixture()
    const branch = await branches.create({ title: 'work' })
    await log.append({ branchId: branch.id, runId, drafts: [said('one'), said('two'), said('three')] })

    await branches.rewind({ branchId: branch.id, toSeq: 1 })

    expect((await log.read({ branchId: branch.id })).map((event) => event.seq)).toEqual([1])
    expect((await branches.find({ branchId: branch.id }))?.head).toBe(1)
  })

  it('lets the next append take the sequence the rewind freed', async () => {
    const { branches, log } = await openFixture()
    const branch = await branches.create({ title: 'work' })
    await log.append({ branchId: branch.id, runId, drafts: [said('one'), said('two'), said('three')] })

    await branches.rewind({ branchId: branch.id, toSeq: 1 })
    const appended = await log.append({ branchId: branch.id, runId, drafts: [said('two again')] })

    expect(appended.map((event) => event.seq)).toEqual([2])
    expect((await log.read({ branchId: branch.id })).map((event) => event.seq)).toEqual([1, 2])
    expect((await branches.find({ branchId: branch.id }))?.head).toBe(2)
  })

  it('empties the branch when rewound to zero', async () => {
    const { branches, log } = await openFixture()
    const branch = await branches.create({ title: 'work' })
    await log.append({ branchId: branch.id, runId, drafts: [said('one'), said('two')] })

    await branches.rewind({ branchId: branch.id, toSeq: 0 })

    expect(await log.read({ branchId: branch.id })).toEqual([])
    expect((await branches.find({ branchId: branch.id }))?.head).toBe(0)
    expect((await log.append({ branchId: branch.id, runId, drafts: [said('fresh')] })).at(0)?.seq).toBe(1)
  })

  it('truncates only the branch it was asked about', async () => {
    const { branches, log } = await openFixture()
    const kept = await branches.create({ title: 'kept' })
    const cut = await branches.create({ title: 'cut' })
    await log.append({ branchId: kept.id, runId, drafts: [said('one'), said('two')] })
    await log.append({ branchId: cut.id, runId, drafts: [said('one'), said('two')] })

    await branches.rewind({ branchId: cut.id, toSeq: 1 })

    expect((await log.read({ branchId: kept.id })).length).toBe(2)
    expect((await branches.find({ branchId: kept.id }))?.head).toBe(2)
  })

  it('keeps the suffix when the head update fails', async () => {
    const { branches, log, prisma } = await openFixture()
    const branch = await branches.create({ title: 'work' })
    await log.append({ branchId: branch.id, runId, drafts: [said('one'), said('two'), said('three')] })
    await refuseHeadOf({ prisma, head: 1 })

    await expect(branches.rewind({ branchId: branch.id, toSeq: 1 })).rejects.toThrow()

    expect((await log.read({ branchId: branch.id })).map((event) => event.seq)).toEqual([1, 2, 3])
    expect((await branches.find({ branchId: branch.id }))?.head).toBe(3)
  })

  it('survives a rewind racing an append from another writer', async () => {
    const { branches, log } = await openFixture()
    const branch = await branches.create({ title: 'work' })
    await log.append({ branchId: branch.id, runId, drafts: [said('one'), said('two'), said('three')] })
    const second = await openSecondWriter(fixture)

    try {
      await Promise.all([
        branches.rewind({ branchId: branch.id, toSeq: 2 }),
        second.log.append({ branchId: branch.id, runId, drafts: [said('four')] }),
      ])

      const seqs = (await log.read({ branchId: branch.id })).map((event) => event.seq)
      expect([2, 3]).toContain(seqs.length)
      expect(seqs).toEqual(Array.from({ length: seqs.length }, (_unused, index) => index + 1))
      expect((await branches.find({ branchId: branch.id }))?.head).toBe(seqs.length)
    } finally {
      await second.close()
    }
  })
})
