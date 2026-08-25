import { afterEach, describe, expect, it } from 'bun:test'

import { toBranchId, toRunId, type EventDraft } from '@dltech/atlas-core'

import { openStoreFixture, type StoreFixture } from './harness'

let fixture: StoreFixture

const runId = toRunId('run-1')
const said = (text: string): EventDraft => ({ type: 'user-said', text })

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
