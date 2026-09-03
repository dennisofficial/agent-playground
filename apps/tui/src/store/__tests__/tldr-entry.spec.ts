import { ETldrStatus, toRunId, toThreadId, type Event } from '@dltech/atlas-core'
import { ETurnStatus, type TurnSpend } from '@dltech/atlas-harness'
import { describe, expect, it } from 'bun:test'

import { deriveTranscript } from '../derive-transcript'
import { durableEntries } from '../durable-entries'
import { EEntryKind } from '../transcript-model'

const THREAD = toThreadId('thread-1')

const ASKED = toRunId('run-asked')

const ANSWERED = toRunId('run-answered')

const event = (over: Partial<Event> & Pick<Event, 'type'>): Event =>
  ({
    id: `event-${String(over.seq ?? 1)}`,
    seq: 1,
    threadId: THREAD,
    runId: ANSWERED,
    depth: 0,
    at: '2026-09-02T18:32:00.000Z',
    ...over,
  }) as Event

const tldr = (args: { anchorSeq: number; throughSeq: number; text: string; seq: number }): Event =>
  event({
    type: 'tldr-written',
    anchorSeq: args.anchorSeq,
    throughSeq: args.throughSeq,
    text: args.text,
    modelId: 'claude-haiku-4-5-20251001',
    status: ETldrStatus.Done,
    seq: args.seq,
    runId: toRunId(`run-tldr-${args.seq}`),
  })

describe('a tldr footer in the transcript', () => {
  it('renders inside the turn, at the head it summarized to', () => {
    const entries = durableEntries({
      events: [
        event({ type: 'user-said', text: 'fix it', seq: 1, runId: ASKED }),
        event({ type: 'assistant-said', parts: [{ type: 'text', text: 'fixed' }], seq: 2 }),
        tldr({ anchorSeq: 1, throughSeq: 2, text: 'Fixed the thing.', seq: 3 }),
      ],
    })

    expect(entries.map((entry) => entry.kind)).toEqual([
      EEntryKind.OperatorSaid,
      EEntryKind.ModelSaid,
      EEntryKind.TldrWritten,
    ])
    expect(entries[2]?.kind === EEntryKind.TldrWritten ? entries[2].text : '').toBe(
      'Fixed the thing.',
    )
  })

  it('keeps the superseded footer of the same anchor out of the transcript', () => {
    const entries = durableEntries({
      events: [
        event({ type: 'user-said', text: 'fix it', seq: 1, runId: ASKED }),
        event({ type: 'assistant-said', parts: [{ type: 'text', text: 'fixed, building' }], seq: 2 }),
        tldr({ anchorSeq: 1, throughSeq: 2, text: 'Fixed; build running.', seq: 3 }),
        event({ type: 'assistant-said', parts: [{ type: 'text', text: 'build green' }], seq: 4 }),
        tldr({ anchorSeq: 1, throughSeq: 4, text: 'Fixed and green.', seq: 5 }),
      ],
    })

    const footers = entries.filter((entry) => entry.kind === EEntryKind.TldrWritten)
    expect(footers).toHaveLength(1)
    expect(footers[0]?.kind === EEntryKind.TldrWritten ? footers[0].text : '').toBe(
      'Fixed and green.',
    )
    expect(entries.map((entry) => entry.kind)).toEqual([
      EEntryKind.OperatorSaid,
      EEntryKind.ModelSaid,
      EEntryKind.ModelSaid,
      EEntryKind.TldrWritten,
    ])
  })

  it('keeps footers of different anchors apart', () => {
    const entries = durableEntries({
      events: [
        event({ type: 'user-said', text: 'one', seq: 1, runId: ASKED }),
        event({ type: 'assistant-said', parts: [{ type: 'text', text: 'a' }], seq: 2 }),
        tldr({ anchorSeq: 1, throughSeq: 2, text: 'First.', seq: 3 }),
        event({ type: 'user-said', text: 'two', seq: 4, runId: ASKED }),
        event({ type: 'assistant-said', parts: [{ type: 'text', text: 'b' }], seq: 5 }),
        tldr({ anchorSeq: 4, throughSeq: 5, text: 'Second.', seq: 6 }),
      ],
    })

    const footers = entries.filter((entry) => entry.kind === EEntryKind.TldrWritten)
    expect(footers.map((entry) => entry.text)).toEqual(['First.', 'Second.'])
  })
})

const spend = (over: Partial<TurnSpend> = {}): TurnSpend => ({
  runId: ANSWERED,
  threadId: THREAD,
  status: ETurnStatus.Completed,
  providerId: 'anthropic',
  modelId: 'claude-sonnet-5',
  steps: 1,
  inputTokens: 400,
  outputTokens: 1_100,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  startedAt: '2026-09-02T18:31:06.000Z',
  endedAt: '2026-09-02T18:32:00.000Z',
  durationMs: 54_000,
  ...over,
})

const exchange: readonly Event[] = [
  event({ type: 'user-said', text: 'go', seq: 1, runId: ASKED }),
  event({ type: 'assistant-said', parts: [{ type: 'text', text: 'done' }], seq: 2 }),
]

describe('a footer still generating', () => {
  it('lands inside the turn, ahead of the worked line', () => {
    const model = deriveTranscript({
      events: exchange,
      signals: [],
      turns: [spend()],
      pendingTldr: { anchorSeq: 1, text: '' },
    })

    expect(model.entries.map((entry) => entry.kind)).toEqual([
      EEntryKind.OperatorSaid,
      EEntryKind.ModelSaid,
      EEntryKind.TldrWritten,
      EEntryKind.TurnEnded,
    ])
    expect(model.entries[2]?.kind === EEntryKind.TldrWritten && model.entries[2].streaming).toBe(
      true,
    )
  })

  it('hides the durable footer of the anchor it is regenerating', () => {
    const model = deriveTranscript({
      events: [...exchange, tldr({ anchorSeq: 1, throughSeq: 2, text: 'Early one.', seq: 3 })],
      signals: [],
      turns: [spend()],
      pendingTldr: { anchorSeq: 1, text: 'Streaming in…' },
    })

    const footers = model.entries.filter((entry) => entry.kind === EEntryKind.TldrWritten)
    expect(footers).toHaveLength(1)
    expect(footers[0]?.text).toBe('Streaming in…')
  })

  it('appends at the end when the turn carried no spend row', () => {
    const model = deriveTranscript({
      events: exchange,
      signals: [],
      pendingTldr: { anchorSeq: 1, text: '' },
    })

    expect(model.entries.at(-1)?.kind).toBe(EEntryKind.TldrWritten)
  })
})

describe('the status pill setting', () => {
  const withStatus: readonly Event[] = [
    ...exchange,
    tldr({ anchorSeq: 1, throughSeq: 2, text: 'Done thing.', seq: 3 }),
  ]

  it('carries the status on the footer by default', () => {
    const model = deriveTranscript({ events: withStatus, signals: [] })
    const footer = model.entries.find((entry) => entry.kind === EEntryKind.TldrWritten)

    expect(footer?.kind === EEntryKind.TldrWritten ? footer.status : undefined).toBe(
      ETldrStatus.Done,
    )
  })

  it('strips the status when the setting is off, and keeps the footer', () => {
    const model = deriveTranscript({ events: withStatus, signals: [], tldrStatus: false })
    const footer = model.entries.find((entry) => entry.kind === EEntryKind.TldrWritten)

    expect(footer?.kind === EEntryKind.TldrWritten ? footer.status : 'missing').toBeUndefined()
  })
})
