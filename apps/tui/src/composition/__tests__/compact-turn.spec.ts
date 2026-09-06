import {
  compactedThrough,
  stampEvent,
  toThreadId,
  toCallId,
  toEventId,
  toRunId,
  type Event,
  type EventDraft,
} from '@dltech/atlas-core'
import { describe, expect, it } from 'bun:test'

import { durableEntries } from '../../store/durable-entries'
import { EEntryKind } from '../../store/transcript-model'
import { autoCompactAfterTurn, EAutoCompact } from '@dltech/atlas-core'

import { compactTurn, ECompaction } from '../compact-turn'
import { fakeAgentRegistry } from './fake-agents'
import { fakeThreadStore, fakeEventLog } from './fake-backend'

const THREAD = toThreadId('compacting')

const AT = '2026-08-25T00:00:00.000Z'

const THOUSAND_TOKENS = 'x'.repeat(4_000)

const stamped = (drafts: readonly EventDraft[]): Event[] =>
  drafts.map((draft, index) =>
    stampEvent({
      draft,
      envelope: {
        id: toEventId(`event-${index + 1}`),
        seq: index + 1,
        threadId: THREAD,
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
  it('records a summary and reports how much of the thread it covered', async () => {
    const log = fakeEventLog(stamped(turns(40)))

    const compaction = await compactTurn({
      log,
      threads: fakeThreadStore({ log, existing: [THREAD] }),
      agents: fakeAgentRegistry(),
      threadId: THREAD,
      summarise: summarises('Forty turns of parser work.'),
    })

    expect(compaction.type).toBe(ECompaction.Compacted)
    expect(compactedThrough(await log.read({ threadId: THREAD }))).toBeGreaterThan(0)
  })

  it('compacts everything before the most recent operator turn when asked directly', async () => {
    const log = fakeEventLog(stamped(turns(3)))

    const compaction = await compactTurn({
      log,
      threads: fakeThreadStore({ log, existing: [THREAD] }),
      agents: fakeAgentRegistry(),
      threadId: THREAD,
      summarise: summarises('the earlier turns'),
    })

    if (compaction.type !== ECompaction.Compacted) throw new Error('expected a compaction')
    expect(compaction.throughSeq).toBe(4)
  })

  it('does nothing when the operator has only spoken once, and says nothing about it', async () => {
    const log = fakeEventLog(stamped(turns(1)))

    const compaction = await compactTurn({
      log,
      threads: fakeThreadStore({ log, existing: [THREAD] }),
      agents: fakeAgentRegistry(),
      threadId: THREAD,
      summarise: summarises('should never be asked for'),
    })

    expect(compaction).toEqual({ type: ECompaction.Nothing })
  })

  it('reports a refusal rather than compacting when the summariser comes back empty', async () => {
    const log = fakeEventLog(stamped(turns(40)))

    const compaction = await compactTurn({
      log,
      threads: fakeThreadStore({ log, existing: [THREAD] }),
      agents: fakeAgentRegistry(),
      threadId: THREAD,
      summarise: summarises(null),
    })

    expect(compaction.type).toBe(ECompaction.Refused)
    expect(compactedThrough(await log.read({ threadId: THREAD }))).toBe(0)
  })

  it('leaves a thread whose tool call has not settled alone', async () => {
    const log = fakeEventLog(
      stamped([
        ...turns(40),
        { type: 'tool-called', callId: toCallId('call-1'), name: 'bash', input: {}, ordinal: 0 },
      ]),
    )

    const compaction = await compactTurn({
      log,
      threads: fakeThreadStore({ log, existing: [THREAD] }),
      agents: fakeAgentRegistry(),
      threadId: THREAD,
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
      threads: fakeThreadStore({ log, existing: [THREAD] }),
      agents: fakeAgentRegistry(),
      threadId: THREAD,
      summarise: summarises('Forty turns of parser work.'),
    })
    if (compaction.type !== ECompaction.Compacted) throw new Error('expected a compaction')

    const remaining = await log.read({ threadId: THREAD })
    const entries = durableEntries({ events: remaining })

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
      threads: fakeThreadStore({ log, existing: [THREAD] }),
      agents: fakeAgentRegistry(),
      threadId: THREAD,
      summarise: summarises('Forty turns of parser work.'),
    })

    const remaining = await log.read({ threadId: THREAD })
    expect(remaining.some((event) => event.type === 'tool-called')).toBe(true)
    expect(remaining.some((event) => event.type === 'tool-result')).toBe(true)
  })
})

describe('compacting without being asked', () => {
  const decide = (args: { used: number; atPercent: number }) =>
    autoCompactAfterTurn({ used: args.used, window: 200_000, atPercent: args.atPercent })

  it('holds below the threshold the operator set', () => {
    expect(decide({ used: 170_000, atPercent: 90 })).toBe(EAutoCompact.Hold)
  })

  it('fires once a settled turn crosses it', () => {
    expect(decide({ used: 181_000, atPercent: 90 })).toBe(EAutoCompact.AtTurnEnd)
  })

  it('never fires when the operator turned it off', () => {
    expect(decide({ used: 199_000, atPercent: 0 })).toBe(EAutoCompact.Hold)
  })
})
