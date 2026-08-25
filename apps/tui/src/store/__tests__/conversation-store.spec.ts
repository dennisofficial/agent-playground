import { beforeEach, describe, expect, it } from 'bun:test'

import type { Event } from '@dltech/atlas-core'
import { createDeltaChannel, type DeltaChannel } from '@dltech/atlas-harness'

import { createConversationStore, type ConversationStore } from '../conversation-store'
import { EEntryKind } from '../transcript-model'
import { fixtureBranchId, log } from './fixture'

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
    store = createConversationStore({ channel, branchId: fixtureBranchId })
  })

  it('opens on a usable empty transcript for a branch with nothing in it', () => {
    expect(store.getSnapshot().isEmpty).toBe(true)
    expect(store.getSnapshot().entries).toEqual([])
  })

  it('returns the same snapshot until something changes', () => {
    const first = store.getSnapshot()

    expect(store.getSnapshot()).toBe(first)

    store.setEvents(log([{ type: 'user-said', text: 'hello' }]))

    expect(store.getSnapshot()).not.toBe(first)
    expect(store.getSnapshot()).toBe(store.getSnapshot())
  })

  it('notifies subscribers when events land and when deltas arrive', () => {
    let notices = 0
    store.subscribe(() => void (notices += 1))

    store.setEvents(log([{ type: 'user-said', text: 'hello' }]))
    const afterEvents = notices
    channel.publisherFor({ branchId: fixtureBranchId }).onChunk({ type: 'text-delta', id: 'b1', text: 'hi' })

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

    store.setEvents(question)
    const publisher = channel.publisherFor({ branchId: fixtureBranchId })
    publisher.onChunk({ type: 'text-delta', id: 'b1', text: 'hi ' })
    publisher.onChunk({ type: 'text-delta', id: 'b1', text: 'there' })

    const seen = [answersOf(store)]
    publisher.settleAppend({ events: [reply] })
    seen.push(answersOf(store))
    store.setEvents(durable)
    seen.push(answersOf(store))

    expect(seen).toEqual([['hi there'], ['hi there'], ['hi there']])
  })

  it('leaves no ghost of a settled step behind when the next one streams', () => {
    const durable = log([{ type: 'assistant-said', parts: [{ type: 'text', text: 'done' }] }])
    const reply = durable[0]
    if (reply === undefined) throw new Error('fixture lost its reply')

    const publisher = channel.publisherFor({ branchId: fixtureBranchId })
    publisher.onChunk({ type: 'text-delta', id: 'b1', text: 'done' })
    publisher.settleAppend({ events: [reply] })
    store.setEvents(durable)
    channel.publisherFor({ branchId: fixtureBranchId }).onChunk({ type: 'text-delta', id: 'b2', text: 'again' })

    expect(textOf(store)).toEqual(['done', 'again'])
  })

  it('stops following the channel once disposed', () => {
    store.dispose()
    channel.publisherFor({ branchId: fixtureBranchId }).onChunk({ type: 'text-delta', id: 'b1', text: 'hi' })

    expect(store.getSnapshot().isEmpty).toBe(true)
  })
})
