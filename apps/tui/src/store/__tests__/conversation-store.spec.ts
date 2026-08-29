import { beforeEach, describe, expect, it } from 'bun:test'

import type { Event } from '@dltech/atlas-core'
import { createDeltaChannel, EStepEnd, type DeltaChannel } from '@dltech/atlas-harness'

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
    channel.publisherFor({ threadId: fixtureThreadId }).onChunk({ type: 'text-delta', id: 'b1', text: 'hi' })

    expect(afterEvents).toBeGreaterThan(0)
    expect(notices).toBeGreaterThan(afterEvents)
    expect(textOf(store)).toEqual(['hello', 'hi'])
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
    channel.publisherFor({ threadId: fixtureThreadId }).onChunk({ type: 'text-delta', id: 'b2', text: 'again' })

    expect(textOf(store)).toEqual(['done', 'again'])
  })

  it('stops following the channel once disposed', () => {
    store.dispose()
    channel.publisherFor({ threadId: fixtureThreadId }).onChunk({ type: 'text-delta', id: 'b1', text: 'hi' })

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
