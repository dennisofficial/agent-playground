import { beforeEach, describe, expect, it } from 'bun:test'

import { toRunId, type Event } from '@dltech/atlas-core'
import {
  createDeltaChannel,
  EStepEnd,
  type DeltaChannel,
  type TurnSpend,
} from '@dltech/atlas-harness'

import { createConversationStore, type ConversationStore } from '../conversation-store'
import { EEntryKind } from '../transcript-model'
import { fixtureThreadId, log } from './fixture'

const textOf = (store: ConversationStore) => store.getSnapshot().entries.map((entry) => entry.text)

const answersOf = (store: ConversationStore) =>
  store
    .getSnapshot()
    .entries.filter((entry) => entry.kind === EEntryKind.ModelSaid)
    .map((entry) => entry.text)

describe('the conversation store', () => {
  let channel: DeltaChannel
  let store: ConversationStore

  beforeEach(() => {
    channel = createDeltaChannel()
    store = createConversationStore({ channel, threadId: fixtureThreadId })
  })

  it('opens on a usable empty transcript for a thread with nothing in it', () => {
    expect(store.getSnapshot().isEmpty).toBe(true)
    expect(store.getSnapshot().entries).toEqual([])
  })

  it('returns the same snapshot until something changes', () => {
    const first = store.getSnapshot()

    expect(store.getSnapshot()).toBe(first)

    store.setEvents({ events: log([{ type: 'user-said', text: 'hello' }]) })

    expect(store.getSnapshot()).not.toBe(first)
    expect(store.getSnapshot()).toBe(store.getSnapshot())
  })

  it('notifies subscribers when events land and when deltas arrive', () => {
    let notices = 0
    store.subscribe(() => void (notices += 1))

    store.setEvents({ events: log([{ type: 'user-said', text: 'hello' }]) })
    const afterEvents = notices
    channel
      .publisherFor({ threadId: fixtureThreadId })
      .onChunk({ type: 'text-delta', id: 'b1', text: 'hi' })

    expect(afterEvents).toBeGreaterThan(0)
    expect(notices).toBeGreaterThan(afterEvents)
    expect(textOf(store)).toEqual(['hello', 'hi'])
  })

  it('drops every in-flight step on resetSteps, so a rewind leaves nothing half-drawn', () => {
    channel
      .publisherFor({ threadId: fixtureThreadId })
      .onChunk({ type: 'text-delta', id: 'b1', text: 'half said' })

    expect(textOf(store)).toEqual(['half said'])

    store.resetSteps()

    expect(store.getSnapshot().entries).toEqual([])
  })

  it('shows the reply exactly once across a real commit handoff', () => {
    const question = log([{ type: 'user-said', text: 'hello' }])
    const durable: Event[] = log([
      { type: 'user-said', text: 'hello' },
      { type: 'assistant-said', parts: [{ type: 'text', text: 'hi there' }] },
    ])
    const reply = durable[1]
    if (reply === undefined) throw new Error('fixture lost its reply')

    store.setEvents({ events: question })
    const publisher = channel.publisherFor({ threadId: fixtureThreadId })
    publisher.onChunk({ type: 'text-delta', id: 'b1', text: 'hi ' })
    publisher.onChunk({ type: 'text-delta', id: 'b1', text: 'there' })

    const seen = [answersOf(store)]
    publisher.settleAppend({ events: [reply] })
    seen.push(answersOf(store))
    store.setEvents({ events: durable })
    seen.push(answersOf(store))

    expect(seen).toEqual([['hi there'], ['hi there'], ['hi there']])
  })

  it('leaves no ghost of a settled step behind when the next one streams', () => {
    const durable = log([{ type: 'assistant-said', parts: [{ type: 'text', text: 'done' }] }])
    const reply = durable[0]
    if (reply === undefined) throw new Error('fixture lost its reply')

    const publisher = channel.publisherFor({ threadId: fixtureThreadId })
    publisher.onChunk({ type: 'text-delta', id: 'b1', text: 'done' })
    publisher.settleAppend({ events: [reply] })
    store.setEvents({ events: durable })
    channel
      .publisherFor({ threadId: fixtureThreadId })
      .onChunk({ type: 'text-delta', id: 'b2', text: 'again' })

    expect(textOf(store)).toEqual(['done', 'again'])
  })

  it('stops following the channel once disposed', () => {
    store.dispose()
    channel
      .publisherFor({ threadId: fixtureThreadId })
      .onChunk({ type: 'text-delta', id: 'b1', text: 'hi' })

    expect(store.getSnapshot().isEmpty).toBe(true)
  })
})

describe('a failure the store is holding on screen', () => {
  let channel: DeltaChannel
  let store: ConversationStore

  beforeEach(() => {
    channel = createDeltaChannel()
    store = createConversationStore({ channel, threadId: fixtureThreadId })
  })

  const failAStep = () => {
    const publisher = channel.publisherFor({ threadId: fixtureThreadId })
    publisher.onChunk({ type: 'text-delta', id: 'b1', text: 'part way' })
    publisher.onChunk({ type: 'error', message: 'The operation timed out.' })
    publisher.close({ end: EStepEnd.Failed })
  }

  it('stays put while nothing has superseded it', () => {
    failAStep()

    expect(store.getSnapshot().failure).toEqual({ message: 'The operation timed out.' })
  })

  it('is retired the moment a retry takes over, so the working line can show', () => {
    failAStep()
    store.supersedeFailure()

    expect(store.getSnapshot().failure).toBeNull()
  })

  it('notifies subscribers when it is retired, and only when there was one', () => {
    let notices = 0
    failAStep()
    store.subscribe(() => void (notices += 1))

    store.supersedeFailure()
    const afterRetiring = notices
    store.supersedeFailure()

    expect(afterRetiring).toBe(1)
    expect(notices).toBe(1)
  })
})

describe('the store lets the composition root fold the same log', () => {
  it('projects the log it was opened on, before any turn runs', () => {
    const seen: number[] = []
    createConversationStore({
      channel: createDeltaChannel(),
      threadId: fixtureThreadId,
      events: log([{ type: 'user-said', text: 'resumed' }]),
      projectEvents: ({ events }) => void seen.push(events.length),
    })

    expect(seen).toEqual([1])
  })

  it('projects again whenever the log changes', () => {
    const seen: number[] = []
    const opened = createConversationStore({
      channel: createDeltaChannel(),
      threadId: fixtureThreadId,
      projectEvents: ({ events }) => void seen.push(events.length),
    })

    opened.setEvents({ events: log([{ type: 'user-said', text: 'one' }]) })
    opened.setEvents({
      events: log([
        { type: 'user-said', text: 'one' },
        { type: 'user-said', text: 'two' },
      ]),
    })

    expect(seen).toEqual([0, 1, 2])
  })

  it('hands the projection the same array the sidebar was derived from', () => {
    const projected: (readonly Event[])[] = []
    const events = log([{ type: 'user-said', text: 'one' }])
    const opened = createConversationStore({
      channel: createDeltaChannel(),
      threadId: fixtureThreadId,
      projectEvents: ({ events: folded }) => void projected.push(folded),
    })

    opened.setEvents({ events })

    expect(projected.at(-1)).toBe(events)
  })
})

describe('a refresh that re-read the same log', () => {
  let channel: DeltaChannel
  let store: ConversationStore

  const spend: TurnSpend = {
    runId: toRunId('run-1'),
    threadId: fixtureThreadId,
    status: 'completed',
    providerId: 'anthropic',
    modelId: 'claude-opus-5',
    steps: 2,
    inputTokens: 1_000,
    outputTokens: 200,
    cacheReadTokens: 50,
    cacheWriteTokens: 10,
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:01:00.000Z',
    durationMs: 60_000,
  }

  beforeEach(() => {
    channel = createDeltaChannel()
    store = createConversationStore({ channel, threadId: fixtureThreadId })
  })

  it('wakes nobody when the read returns the same rows in a fresh array', () => {
    const events = log([{ type: 'user-said', text: 'hello' }])
    store.setEvents({ events })
    const before = store.getSnapshot()

    let notices = 0
    store.subscribe(() => void (notices += 1))
    store.setEvents({ events: [...events] })

    expect(notices).toBe(0)
    expect(store.getSnapshot()).toBe(before)
  })

  it('wakes nobody when the spend comes back as fresh rows saying the same thing', () => {
    const events = log([{ type: 'user-said', text: 'hello' }])
    store.setEvents({ events, turns: [spend] })

    let notices = 0
    store.subscribe(() => void (notices += 1))
    store.setEvents({ events: [...events], turns: [{ ...spend }] })

    expect(notices).toBe(0)
  })

  it('wakes the view when the spend moved', () => {
    const events = log([{ type: 'user-said', text: 'hello' }])
    store.setEvents({ events, turns: [spend] })

    let notices = 0
    store.subscribe(() => void (notices += 1))
    store.setEvents({
      events: [...events],
      turns: [{ ...spend, outputTokens: spend.outputTokens + 50 }],
    })

    expect(notices).toBe(1)
  })

  it('still wakes the view the moment a row actually lands', () => {
    const events = log([{ type: 'user-said', text: 'hello' }])
    store.setEvents({ events })

    let notices = 0
    store.subscribe(() => void (notices += 1))
    store.setEvents({
      events: [...events, ...log([{ type: 'user-said', text: 'again' }])],
    })

    expect(notices).toBe(1)
  })
})
