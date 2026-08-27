import {
  compactedThrough,
  stampEvent,
  toBranchId,
  toCallId,
  toEventId,
  toRunId,
  type Event,
  type EventDraft,
} from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import { durableEntries } from '../../store/durable-entries'
import { EEntryKind } from '../../store/transcript-model'
import { compactTurn, ECompaction } from '../compact-turn'
import { fakeBranchStore, fakeEventLog } from './fake-backend'

const BRANCH = toBranchId('compacting')

const AT = '2026-08-25T00:00:00.000Z'

const THOUSAND_TOKENS = 'x'.repeat(4_000)

const stamped = (drafts: readonly EventDraft[]): Event[] =>
  drafts.map((draft, index) =>
    stampEvent({
      draft,
      envelope: {
        id: toEventId(`event-${index + 1}`),
        seq: index + 1,
        branchId: BRANCH,
        runId: toRunId('run-1'),
        depth: 0,
        at: AT,
      },
    }),
  )

const turns = (count: number): readonly EventDraft[] =>
  Array.from({ length: count }, () => [
    { type: 'user-said', text: THOUSAND_TOKENS } as const,
    { type: 'assistant-said', parts: [{ type: 'text', text: THOUSAND_TOKENS }] } as const,
  ]).flat()

const summarises = (summary: string | null) => async () => summary



describe('compacting a conversation the operator asked to compact', () => {
  it('records a summary and reports how much of the branch it covered', async () => {
    const log = fakeEventLog(stamped(turns(40)))

    const compaction = await compactTurn({
      log,
      branches: fakeBranchStore({ log, existing: [BRANCH] }),
      branchId: BRANCH,
      keepRecentTokens: 10_000,
      summarise: summarises('Forty turns of parser work.'),
    })

    expect(compaction.type).toBe(ECompaction.Compacted)
    expect(compactedThrough(await log.read({ branchId: BRANCH }))).toBeGreaterThan(0)
  })

  it('does nothing to a conversation that still fits, rather than compacting for the sake of it', async () => {
    const log = fakeEventLog(stamped(turns(2)))

    const compaction = await compactTurn({
      log,
      branches: fakeBranchStore({ log, existing: [BRANCH] }),
      branchId: BRANCH,
      keepRecentTokens: 100_000,
      summarise: summarises('should never be asked for'),
    })

    expect(compaction).toEqual({ type: ECompaction.Nothing })
  })

  it('reports a refusal rather than compacting when the summariser comes back empty', async () => {
    const log = fakeEventLog(stamped(turns(40)))

    const compaction = await compactTurn({
      log,
      branches: fakeBranchStore({ log, existing: [BRANCH] }),
      branchId: BRANCH,
      keepRecentTokens: 10_000,
      summarise: summarises(null),
    })

    expect(compaction.type).toBe(ECompaction.Refused)
    expect(compactedThrough(await log.read({ branchId: BRANCH }))).toBe(0)
  })

  it('leaves a branch whose tool call has not settled alone', async () => {
    const log = fakeEventLog(
      stamped([
        ...turns(40),
        { type: 'tool-called', callId: toCallId('call-1'), name: 'bash', input: {}, ordinal: 0 },
      ]),
    )

    const compaction = await compactTurn({
      log,
      branches: fakeBranchStore({ log, existing: [BRANCH] }),
      branchId: BRANCH,
      keepRecentTokens: 10_000,
      summarise: summarises('a summary'),
    })

    expect(compaction.type).not.toBe(ECompaction.Refused)
  })
})

describe('what the transcript shows after a compaction', () => {
  it('holds only the summary and the turns the model can still read', async () => {
    const log = fakeEventLog(stamped(turns(40)))

    const compaction = await compactTurn({
      log,
      branches: fakeBranchStore({ log, existing: [BRANCH] }),
      branchId: BRANCH,
      keepRecentTokens: 10_000,
      summarise: summarises('Forty turns of parser work.'),
    })
    if (compaction.type !== ECompaction.Compacted) throw new Error('expected a compaction')

    const remaining = await log.read({ branchId: BRANCH })
    const entries = durableEntries(remaining)

    expect(entries[0]?.kind).toBe(EEntryKind.HistoryCompacted)
    expect(entries[0]?.text).toBe('Forty turns of parser work.')
    expect(remaining.every((event) => event.seq >= compaction.throughSeq)).toBe(true)
    expect(entries.filter((entry) => entry.kind === EEntryKind.HistoryCompacted)).toHaveLength(1)
  })

  it('keeps a settled tool call that survived the watermark, rather than dropping it', async () => {
    const log = fakeEventLog(
      stamped([
        ...turns(40),
        { type: 'user-said', text: 'run the tests' },
        { type: 'tool-called', callId: toCallId('call-1'), name: 'bash', input: {}, ordinal: 0 },
        { type: 'tool-result', callId: toCallId('call-1'), name: 'bash', output: { ok: true } },
      ]),
    )

    await compactTurn({
      log,
      branches: fakeBranchStore({ log, existing: [BRANCH] }),
      branchId: BRANCH,
      keepRecentTokens: 2_000,
      summarise: summarises('Forty turns of parser work.'),
    })

    const remaining = await log.read({ branchId: BRANCH })
    expect(remaining.some((event) => event.type === 'tool-called')).toBe(true)
    expect(remaining.some((event) => event.type === 'tool-result')).toBe(true)
  })
})
