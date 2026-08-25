import { describe, expect, it } from 'bun:test'

import { toBranchId, toCallId, toEventId, toRunId, type Chunk, type Event } from '@dltech/atlas-core'

import { createDeltaChannel, EStepEnd } from '..'
import { firstStepId, recorder, stepEnded } from './signals'

const branchId = toBranchId('branch-1')

const textBlock = (id: string, deltas: readonly string[]): Chunk[] => [
  { type: 'text-start', id },
  ...deltas.map((text): Chunk => ({ type: 'text-delta', id, text })),
  { type: 'text-end', id },
]

const assistantSaid = (args: { seq: number; text: string; interrupted?: boolean }): Event => ({
  type: 'assistant-said',
  parts: [{ type: 'text', text: args.text }],
  ...(args.interrupted === undefined ? {} : { interrupted: args.interrupted }),
  id: toEventId(`event-${args.seq}`),
  seq: args.seq,
  branchId,
  runId: toRunId('run-1'),
  depth: 0,
  at: '2026-08-24T00:00:00.000Z',
})

describe('a branch that is not mid-step', () => {
  it('yields an empty channel rather than an error', () => {
    const channel = createDeltaChannel()
    const { seen, listener } = recorder()

    const unsubscribe = channel.subscribe({ branchId, listener })

    expect(channel.snapshot({ branchId })).toEqual([])
    expect(seen).toEqual([])
    unsubscribe()
  })
})

describe('the step in flight', () => {
  it('carries text deltas and their block boundaries', () => {
    const channel = createDeltaChannel()
    const { seen, listener } = recorder()
    channel.subscribe({ branchId, listener })
    const publisher = channel.publisherFor({ branchId })

    for (const chunk of textBlock('t1', ['auth ', 'and the router'])) publisher.onChunk(chunk)

    expect(seen[0]?.type).toBe('step-started')
    expect(seen.slice(1).map((signal) => (signal.type === 'chunk' ? signal.chunk : null))).toEqual(
      textBlock('t1', ['auth ', 'and the router']),
    )
  })

  it('carries reasoning deltas as distinct blocks', () => {
    const channel = createDeltaChannel()
    const { seen, listener } = recorder()
    channel.subscribe({ branchId, listener })
    const publisher = channel.publisherFor({ branchId })

    publisher.onChunk({ type: 'reasoning-start', id: 'r1' })
    publisher.onChunk({ type: 'reasoning-delta', id: 'r1', text: 'two files touched' })
    publisher.onChunk({ type: 'reasoning-end', id: 'r1' })

    expect(seen.filter((signal) => signal.type === 'chunk').map((signal) => signal.chunk.type)).toEqual([
      'reasoning-start',
      'reasoning-delta',
      'reasoning-end',
    ])
  })

  it('returns the chunk unchanged so the accumulator still sees it', () => {
    const channel = createDeltaChannel()
    const publisher = channel.publisherFor({ branchId })
    const chunk: Chunk = { type: 'text-delta', id: 't1', text: 'auth' }

    expect(publisher.onChunk(chunk)).toBe(chunk)
  })

  it('stamps every signal of one step with the same step id, and a later step with another', () => {
    const channel = createDeltaChannel()
    const { seen, listener } = recorder()
    channel.subscribe({ branchId, listener })
    const publisher = channel.publisherFor({ branchId })

    publisher.onChunk({ type: 'text-delta', id: 't1', text: 'first' })
    publisher.settleAppend({ events: [assistantSaid({ seq: 2, text: 'first' })] })
    publisher.onChunk({ type: 'text-delta', id: 't2', text: 'second' })

    const stepIds = seen.map((signal) => signal.stepId)
    expect(new Set(stepIds.slice(0, 3)).size).toBe(1)
    expect(stepIds[3]).not.toBe(stepIds[0])
  })
})

describe('completing a step', () => {
  it('emits a signal naming the durable event that supersedes the deltas', () => {
    const channel = createDeltaChannel()
    const { seen, listener } = recorder()
    channel.subscribe({ branchId, listener })
    const publisher = channel.publisherFor({ branchId })
    for (const chunk of textBlock('t1', ['auth and the router'])) publisher.onChunk(chunk)

    publisher.settleAppend({ events: [assistantSaid({ seq: 2, text: 'auth and the router' })] })

    const ended = seen.at(-1)
    expect(ended).toEqual({
      type: 'step-ended',
      stepId: firstStepId(seen),
      end: EStepEnd.Completed,
      supersededBy: { eventId: toEventId('event-2'), seq: 2 },
    })
  })

  it('names the step interrupted when the durable event says it was', () => {
    const channel = createDeltaChannel()
    const { seen, listener } = recorder()
    channel.subscribe({ branchId, listener })
    const publisher = channel.publisherFor({ branchId })
    publisher.onChunk({ type: 'text-delta', id: 't1', text: 'half a th' })

    publisher.settleAppend({ events: [assistantSaid({ seq: 2, text: 'half a th', interrupted: true })] })

    const ended = stepEnded(seen)
    expect(ended.end).toBe(EStepEnd.Interrupted)
    expect(ended.supersededBy).toEqual({ eventId: toEventId('event-2'), seq: 2 })
  })

  it('supersedes the deltas with nothing when the step committed no assistant turn', () => {
    const channel = createDeltaChannel()
    const { seen, listener } = recorder()
    channel.subscribe({ branchId, listener })
    const publisher = channel.publisherFor({ branchId })
    publisher.onChunk({ type: 'tool-call', callId: toCallId('call-1'), name: 'read', input: {} })

    publisher.settleAppend({ events: [] })

    const ended = stepEnded(seen)
    expect(ended.supersededBy).toBeNull()
    expect(ended.end).toBe(EStepEnd.Completed)
  })

  it('leaves the channel empty afterwards', () => {
    const channel = createDeltaChannel()
    const { listener } = recorder()
    channel.subscribe({ branchId, listener })
    const publisher = channel.publisherFor({ branchId })
    for (const chunk of textBlock('t1', ['auth'])) publisher.onChunk(chunk)

    publisher.settleAppend({ events: [assistantSaid({ seq: 2, text: 'auth' })] })

    expect(channel.snapshot({ branchId })).toEqual([])
    const late = recorder()
    channel.subscribe({ branchId, listener: late.listener })
    expect(late.seen).toEqual([])
  })

  it('publishes nothing when no step is in flight, which is the user turn being appended', () => {
    const channel = createDeltaChannel()
    const { seen, listener } = recorder()
    channel.subscribe({ branchId, listener })

    channel.publisherFor({ branchId }).settleAppend({ events: [assistantSaid({ seq: 1, text: 'stale' })] })

    expect(seen).toEqual([])
  })
})

describe('a step that never commits', () => {
  it('ends when the publisher is closed, so a subscriber never waits forever', () => {
    const channel = createDeltaChannel()
    const { seen, listener } = recorder()
    channel.subscribe({ branchId, listener })
    const publisher = channel.publisherFor({ branchId })
    publisher.onChunk({ type: 'text-delta', id: 't1', text: 'half a th' })

    publisher.close({ end: EStepEnd.Interrupted })

    expect(seen.at(-1)).toEqual({
      type: 'step-ended',
      stepId: firstStepId(seen),
      end: EStepEnd.Interrupted,
      supersededBy: null,
    })
    expect(channel.snapshot({ branchId })).toEqual([])
  })

  it('opens and ends a step for a failure that never streamed, so it is not silence', () => {
    const channel = createDeltaChannel()
    const { seen, listener } = recorder()
    channel.subscribe({ branchId, listener })

    channel.publisherFor({ branchId }).close({ end: EStepEnd.Failed })

    expect(seen.map((signal) => signal.type)).toEqual(['step-started', 'step-ended'])
    expect(seen.at(-1)).toEqual({
      type: 'step-ended',
      stepId: firstStepId(seen),
      end: EStepEnd.Failed,
      supersededBy: null,
    })
  })

  it('says nothing when a turn that streamed nothing closes without failing', () => {
    const channel = createDeltaChannel()
    const { seen, listener } = recorder()
    channel.subscribe({ branchId, listener })

    channel.publisherFor({ branchId }).close({ end: EStepEnd.Completed })

    expect(seen).toEqual([])
  })

  it('is closed idempotently, so a committed step is not ended twice', () => {
    const channel = createDeltaChannel()
    const { seen, listener } = recorder()
    channel.subscribe({ branchId, listener })
    const publisher = channel.publisherFor({ branchId })
    publisher.onChunk({ type: 'text-delta', id: 't1', text: 'auth' })
    publisher.settleAppend({ events: [assistantSaid({ seq: 2, text: 'auth' })] })

    publisher.close({ end: EStepEnd.Completed })

    expect(seen.filter((signal) => signal.type === 'step-ended')).toHaveLength(1)
  })

  it('gives a failure after the last commit a step of its own rather than swallowing it', () => {
    const channel = createDeltaChannel()
    const { seen, listener } = recorder()
    channel.subscribe({ branchId, listener })
    const publisher = channel.publisherFor({ branchId })
    publisher.onChunk({ type: 'text-delta', id: 't1', text: 'auth' })
    publisher.settleAppend({ events: [assistantSaid({ seq: 2, text: 'auth' })] })

    publisher.close({ end: EStepEnd.Failed })

    const ends = seen.filter((signal) => signal.type === 'step-ended')
    expect(ends.map((signal) => signal.end)).toEqual([EStepEnd.Completed, EStepEnd.Failed])
    expect(ends[0]?.stepId).not.toBe(ends[1]?.stepId)
  })
})

describe('attaching mid-step', () => {
  it('replays the step in flight in order, then continues live', () => {
    const channel = createDeltaChannel()
    const publisher = channel.publisherFor({ branchId })
    publisher.onChunk({ type: 'text-start', id: 't1' })
    publisher.onChunk({ type: 'text-delta', id: 't1', text: 'auth ' })

    const { seen, listener } = recorder()
    channel.subscribe({ branchId, listener })
    publisher.onChunk({ type: 'text-delta', id: 't1', text: 'and the router' })
    publisher.settleAppend({ events: [assistantSaid({ seq: 2, text: 'auth and the router' })] })

    expect(seen.map((signal) => (signal.type === 'chunk' ? signal.chunk.type : signal.type))).toEqual([
      'step-started',
      'text-start',
      'text-delta',
      'text-delta',
      'step-ended',
    ])
    const deltas = seen.flatMap((signal) =>
      signal.type === 'chunk' && signal.chunk.type === 'text-delta' ? [signal.chunk.text] : [],
    )
    expect(deltas.join('')).toBe('auth and the router')
  })
})

describe('unsubscribing', () => {
  it('stops delivery without disturbing the other subscribers', () => {
    const channel = createDeltaChannel()
    const staying = recorder()
    const leaving = recorder()
    channel.subscribe({ branchId, listener: staying.listener })
    const unsubscribe = channel.subscribe({ branchId, listener: leaving.listener })
    const publisher = channel.publisherFor({ branchId })
    publisher.onChunk({ type: 'text-delta', id: 't1', text: 'auth' })

    unsubscribe()
    publisher.onChunk({ type: 'text-delta', id: 't1', text: ' and the router' })

    expect(leaving.seen).toHaveLength(2)
    expect(staying.seen).toHaveLength(3)
  })
})

describe('a filter in front of the channel', () => {
  it('publishes nothing the filter dropped and hides it from the accumulator too', () => {
    const channel = createDeltaChannel()
    const { seen, listener } = recorder()
    channel.subscribe({ branchId, listener })
    const publisher = channel.publisherFor({
      branchId,
      filter: (chunk) => (chunk.type === 'text-delta' && chunk.text.includes('secret') ? null : chunk),
    })

    expect(publisher.onChunk({ type: 'text-delta', id: 't1', text: 'secret token' })).toBeNull()
    publisher.onChunk({ type: 'text-delta', id: 't1', text: 'auth' })

    expect(seen.flatMap((signal) => (signal.type === 'chunk' ? [signal.chunk] : []))).toEqual([
      { type: 'text-delta', id: 't1', text: 'auth' },
    ])
  })
})

describe('the snapshot of the step in flight', () => {
  it('keeps its identity until the next signal, so a react store can hold it', () => {
    const channel = createDeltaChannel()
    const publisher = channel.publisherFor({ branchId })
    publisher.onChunk({ type: 'text-delta', id: 't1', text: 'auth' })

    const first = channel.snapshot({ branchId })
    expect(channel.snapshot({ branchId })).toBe(first)

    publisher.onChunk({ type: 'text-delta', id: 't1', text: ' and the router' })
    expect(channel.snapshot({ branchId })).not.toBe(first)
    expect(first).toHaveLength(2)
  })
})
