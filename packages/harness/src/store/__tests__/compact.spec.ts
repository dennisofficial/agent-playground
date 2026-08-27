import { afterEach, describe, expect, it } from 'bun:test'

import {
  compactedThrough,
  ECompactionRefusal,
  toCallId,
  toRunId,
  type BranchId,
  type EventDraft,
} from '@dltech/atlas-core'

import { compactBranch, ECompactionFailure, type Summarise } from '../compact'
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

const openBranch = async (drafts: readonly EventDraft[]): Promise<BranchId> => {
  fixture = await openStoreFixture()
  const branch = await fixture.branches.create({ title: 'work' })
  await fixture.log.append({ branchId: branch.id, runId, drafts })
  return branch.id
}

const compactTo = (args: { branchId: BranchId; throughSeq: number; summary: string | null }) =>
  compactBranch({
    log: fixture.log,
    branches: fixture.branches,
    branchId: args.branchId,
    throughSeq: args.throughSeq,
    summarise: summarises(args.summary),
  })

afterEach(async () => {
  await fixture.close()
})

describe('compactBranch', () => {
  it('replaces the compacted range with the summary and reports what it swallowed', async () => {
    const branchId = await openBranch([
      said('build the parser'),
      replied('done'),
      said('now the lexer'),
    ])

    const outcome = await compactTo({ branchId, throughSeq: 2, summary: 'A parser was written.' })

    expect(outcome).toEqual({
      ok: true,
      throughSeq: 2,
      replaced: 2,
      summary: 'A parser was written.',
    })
  })

  it('leaves the branch holding the summary in place of the turns it compacted', async () => {
    const branchId = await openBranch([said('build the parser'), replied('done'), said('next')])

    await compactTo({ branchId, throughSeq: 2, summary: 'A parser was written.' })

    const events = await fixture.log.read({ branchId })
    expect(events.map((event) => [event.seq, event.type])).toEqual([
      [2, 'history-compacted'],
      [3, 'user-said'],
    ])
    expect(compactedThrough(events)).toBe(2)
  })

  it('survives a reload, because the summary is a stored event like any other', async () => {
    const branchId = await openBranch([said('build the parser'), replied('done'), said('next')])

    await compactTo({ branchId, throughSeq: 2, summary: 'A parser was written.' })

    const watermark = (await fixture.log.read({ branchId })).find(
      (event) => event.type === 'history-compacted',
    )

    expect(watermark?.type === 'history-compacted' && watermark.summary).toBe('A parser was written.')
    expect(watermark?.type === 'history-compacted' && watermark.replaced).toBe(2)
  })

  it('keeps appending above the summary, so the sequence never collides', async () => {
    const branchId = await openBranch([said('build the parser'), replied('done'), said('next')])

    await compactTo({ branchId, throughSeq: 2, summary: 'A parser was written.' })
    const [appended] = await fixture.log.append({
      branchId,
      runId,
      drafts: [said('and now this')],
    })

    expect(appended?.seq).toBe(4)
  })

  it('compacts again over a branch it already compacted, folding the earlier summary in', async () => {
    const branchId = await openBranch([said('one'), replied('two'), said('three'), replied('four')])

    await compactTo({ branchId, throughSeq: 2, summary: 'the first exchange' })
    const again = await compactTo({ branchId, throughSeq: 4, summary: 'both exchanges' })

    if (!again.ok) throw new Error(again.reason)
    expect(again.replaced).toBe(3)

    const events = await fixture.log.read({ branchId })
    expect(events.map((event) => event.type)).toEqual(['history-compacted'])
    expect(compactedThrough(events)).toBe(4)
  })

  it('refuses a watermark the guard rejects and leaves the branch untouched', async () => {
    const branchId = await openBranch([said('clean the build'), called, resulted])

    const outcome = await compactTo({ branchId, throughSeq: 2, summary: 'never asked for' })

    expect(outcome).toEqual({
      ok: false,
      failure: ECompactionFailure.Refused,
      reason:
        'compacting through 2 would keep the result of bash (call-1) after compacting the call it answers',
      refusal: ECompactionRefusal.SplitsToolCall,
    })
    expect((await fixture.log.read({ branchId })).length).toBe(3)
  })

  it('deletes nothing when the summariser fails, rather than compacting to nothing', async () => {
    const branchId = await openBranch([said('build the parser'), replied('done'), said('next')])

    const outcome = await compactTo({ branchId, throughSeq: 2, summary: null })

    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false && outcome.failure).toBe(ECompactionFailure.NoSummary)
    expect((await fixture.log.read({ branchId })).length).toBe(3)
  })

  it('never asks the summariser for a range the guard already refused', async () => {
    const branchId = await openBranch([said('clean the build'), called, resulted])
    let asked = false

    await compactBranch({
      log: fixture.log,
      branches: fixture.branches,
      branchId,
      throughSeq: 2,
      summarise: async () => {
        asked = true
        return 'a summary'
      },
    })

    expect(asked).toBe(false)
  })
})
