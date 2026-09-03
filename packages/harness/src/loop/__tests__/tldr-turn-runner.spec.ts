import { describe, expect, it } from 'bun:test'
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'

import {
  stampDrafts,
  toCallId,
  toEventId,
  toRunId,
  toThreadId,
  type Event,
  type EventDraft,
  type EventLogPort,
  type IdPort,
} from '@dltech/atlas-core'

import { ETurnStatus, TldrTurnRunner, TurnRunner, type TldrFeed, type TurnOutcome } from '..'
import { scriptedModel } from '../../model/testing/scripted-model'
import { ETldrStatus } from '@dltech/atlas-core'

const THREAD = toThreadId('thread-1')
const RUN = toRunId('run-1')

function inMemoryLog(): EventLogPort & { rows: Event[] } {
  const rows: Event[] = []
  return {
    rows,
    append: ({ drafts }) => {
      const stamped = stampDrafts({
        drafts,
        envelopes: drafts.map((_, index) => ({
          id: toEventId(`evt-${rows.length + index + 1}`),
          seq: rows.length + index + 1,
          threadId: THREAD,
          runId: RUN,
          depth: 0,
          at: new Date(Date.UTC(2026, 0, 1, 0, 0, rows.length + index)).toISOString(),
        })),
      })
      rows.push(...stamped)
      return Promise.resolve(stamped)
    },
    read: () => Promise.resolve([...rows]),
    readOwn: () => Promise.resolve([...rows]),
    head: () => Promise.resolve(rows.length),
  }
}

let runCounter = 0
const ids = { nextRunId: () => toRunId(`run-tldr-${++runCounter}`) } as unknown as IdPort

const tldrModel = (text: string, status: ETldrStatus = ETldrStatus.Done): MockLanguageModelV4 =>
  chunkedModel([JSON.stringify({ status, summary: text })])

function chunkedModel(deltas: readonly string[]): MockLanguageModelV4 {
  const chunks: LanguageModelV4StreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't' },
    ...deltas.map((delta): LanguageModelV4StreamPart => ({ type: 'text-delta', id: 't', delta })),
    { type: 'text-end', id: 't' },
    {
      type: 'finish',
      finishReason: { unified: 'stop', raw: undefined },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
    },
  ]
  return new MockLanguageModelV4({
    doStream: () =>
      Promise.resolve({
        stream: simulateReadableStream({ chunks, initialDelayInMs: 0, chunkDelayInMs: 0 }),
      }),
  })
}

const completed: TurnOutcome = { status: ETurnStatus.Completed, runId: RUN }

function scriptedInner(outcomes: readonly TurnOutcome[]): TurnRunner {
  return new (class extends TurnRunner {
    private index = 0
    say(): Promise<TurnOutcome> {
      return Promise.resolve(outcomes[this.index++] ?? outcomes[0] ?? completed)
    }
    runTurn(): Promise<TurnOutcome> {
      return this.say()
    }
    resume(): Promise<TurnOutcome> {
      return this.say()
    }
  })()
}

async function settled(log: EventLogPort & { rows: Event[] }): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (log.rows.some((event) => event.type === 'tldr-written')) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const quiet = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50))

const seed: readonly EventDraft[] = [
  { type: 'user-said', text: 'fix the redirect' },
  { type: 'assistant-said', parts: [{ type: 'text', text: 'fixed' }] },
]

describe('TldrTurnRunner', () => {
  it('appends a tldr-written event after a completed turn', async () => {
    const log = inMemoryLog()
    await log.append({ threadId: THREAD, runId: RUN, drafts: seed })
    const runner = new TldrTurnRunner({
      inner: scriptedInner([completed]),
      log,
      ids,
      model: tldrModel('Fixed the redirect loop.'),
      modelId: 'test-model',
    })

    await runner.say({ threadId: THREAD, text: 'ignored' })
    await settled(log)

    const written = log.rows.filter((event) => event.type === 'tldr-written')
    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({
      anchorSeq: 1,
      throughSeq: 2,
      text: 'Fixed the redirect loop.',
      status: ETldrStatus.Done,
    })
  })

  it('does not generate for a paused, interrupted or failed turn', async () => {
    const log = inMemoryLog()
    await log.append({ threadId: THREAD, runId: RUN, drafts: seed })
    const runner = new TldrTurnRunner({
      inner: scriptedInner([
        { status: ETurnStatus.Paused, runId: RUN, callId: toCallId('call-1'), reason: 'approval' },
        { status: ETurnStatus.Interrupted, runId: RUN, committed: true },
        { status: ETurnStatus.Failed, runId: RUN, message: 'boom', cause: undefined },
      ]),
      log,
      ids,
      model: tldrModel('should never be written'),
      modelId: 'test-model',
    })

    await runner.say({ threadId: THREAD, text: 'a' })
    await runner.say({ threadId: THREAD, text: 'b' })
    await runner.say({ threadId: THREAD, text: 'c' })
    await quiet()

    expect(log.rows.some((event) => event.type === 'tldr-written')).toBe(false)
  })

  it('appends nothing when the head is already covered', async () => {
    const log = inMemoryLog()
    await log.append({
      threadId: THREAD,
      runId: RUN,
      drafts: [
        ...seed,
        { type: 'tldr-written', anchorSeq: 1, throughSeq: 2, text: 'Fixed.', modelId: 'haiku' },
      ],
    })
    const runner = new TldrTurnRunner({
      inner: scriptedInner([completed]),
      log,
      ids,
      model: tldrModel('duplicate'),
      modelId: 'test-model',
    })

    await runner.say({ threadId: THREAD, text: 'ignored' })
    await quiet()

    expect(log.rows.filter((event) => event.type === 'tldr-written')).toHaveLength(1)
  })

  it('reports started, streamed chunks and finished through the feed', async () => {
    const log = inMemoryLog()
    await log.append({ threadId: THREAD, runId: RUN, drafts: seed })
    const seen: string[] = []
    const feed: TldrFeed = {
      started: ({ anchorSeq }) => seen.push(`started:${anchorSeq}`),
      chunk: ({ text }) => seen.push(`chunk:${text}`),
      finished: () => seen.push('finished'),
    }
    const runner = new TldrTurnRunner({
      inner: scriptedInner([completed]),
      log,
      ids,
      model: chunkedModel(['{"status":"done","summary":"Fixed the', ' redirect loop."}']),
      modelId: 'test-model',
      feed,
    })

    await runner.say({ threadId: THREAD, text: 'ignored' })
    await settled(log)

    expect(seen).toEqual([
      'started:1',
      'chunk:Fixed the',
      'chunk:Fixed the redirect loop.',
      'finished',
    ])
  })

  it('finishes the feed when generation fails, and appends nothing', async () => {
    const log = inMemoryLog()
    await log.append({ threadId: THREAD, runId: RUN, drafts: seed })
    const seen: string[] = []
    const feed: TldrFeed = {
      started: () => seen.push('started'),
      chunk: () => seen.push('chunk'),
      finished: () => seen.push('finished'),
    }
    const runner = new TldrTurnRunner({
      inner: scriptedInner([completed]),
      log,
      ids,
      model: scriptedModel({ script: [{ error: new Error('provider down') }] }),
      modelId: 'test-model',
      feed,
    })

    await runner.say({ threadId: THREAD, text: 'ignored' })
    await quiet()

    expect(seen).toEqual(['started', 'finished'])
    expect(log.rows.some((event) => event.type === 'tldr-written')).toBe(false)
  })
})
