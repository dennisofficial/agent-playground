import { afterEach, describe, expect, it } from 'bun:test'

import { ERewindRefusal, toCallId, toRunId, type BranchId, type EventDraft } from '@dltech/atlas-core'

import { rewindBranch } from '../rewind'
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

const openExchange = async (): Promise<{ fixture: StoreFixture; branchId: BranchId }> => {
  fixture = await openStoreFixture()
  const branch = await fixture.branches.create({ title: 'work' })
  await fixture.log.append({
    branchId: branch.id,
    runId,
    drafts: [said('clean the build'), replied('on it'), called, resulted, replied('done')],
  })
  return { fixture, branchId: branch.id }
}

afterEach(async () => {
  await fixture.close()
})

describe('rewindBranch', () => {
  it('truncates the branch to a settled point and reports what it discarded', async () => {
    const { fixture: store, branchId } = await openExchange()

    const result = await rewindBranch({ log: store.log, branches: store.branches, branchId, toSeq: 2 })

    expect(result).toEqual({ ok: true, discarded: 3 })
    expect((await store.log.read({ branchId })).map((event) => event.type)).toEqual([
      'user-said',
      'assistant-said',
    ])
    expect((await store.branches.find({ branchId }))?.head).toBe(2)
  })

  it('refuses a target that would re-dispatch a tool call, which the surviving idempotencyKey does not deduplicate', async () => {
    const { fixture: store, branchId } = await openExchange()

    const result = await rewindBranch({ log: store.log, branches: store.branches, branchId, toSeq: 3 })

    expect(result).toMatchObject({ ok: false, refusal: ERewindRefusal.UnsettledToolCall })
    expect((await store.log.read({ branchId })).length).toBe(5)
    expect((await store.branches.find({ branchId }))?.head).toBe(5)
  })

  it('refuses a sequence the branch never reached, and writes nothing', async () => {
    const { fixture: store, branchId } = await openExchange()

    const result = await rewindBranch({ log: store.log, branches: store.branches, branchId, toSeq: 9 })

    expect(result).toMatchObject({ ok: false, refusal: ERewindRefusal.NoSuchTarget })
    expect((await store.log.read({ branchId })).length).toBe(5)
    expect((await store.branches.find({ branchId }))?.head).toBe(5)
  })

  it('leaves the branch ready for the next exchange', async () => {
    const { fixture: store, branchId } = await openExchange()

    await rewindBranch({ log: store.log, branches: store.branches, branchId, toSeq: 0 })
    const appended = await store.log.append({ branchId, runId, drafts: [said('start over')] })

    expect(appended.map((event) => event.seq)).toEqual([1])
    expect((await store.log.read({ branchId })).map((event) => event.type)).toEqual(['user-said'])
  })
})
