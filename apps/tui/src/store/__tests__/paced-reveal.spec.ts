import { beforeEach, describe, expect, it } from 'bun:test'

import { createDeltaChannel, type ThreadPublisher, type DeltaChannel } from '@dltech/atlas-harness'

import { createConversationStore, type ConversationStore } from '../conversation-store'
import { EEntryKind } from '../transcript-model'
import { fixtureThreadId, log } from './fixture'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const A_FRAME_OR_TWO = 60

const LONG_ENOUGH_TO_DRAIN = 900

const tailOf = (store: ConversationStore): string =>
  store
    .getSnapshot()
    .entries.filter((entry) => entry.kind !== EEntryKind.OperatorSaid)
    .map((entry) => entry.text)
    .at(-1) ?? ''

describe('the paced reveal', () => {
  let channel: DeltaChannel
  let store: ConversationStore
  let publisher: ThreadPublisher

  beforeEach(() => {
    channel = createDeltaChannel()
    store = createConversationStore({ channel, threadId: fixtureThreadId, paceReveal: true })
    publisher = channel.publisherFor({ threadId: fixtureThreadId })
  })

  it('holds a chunk back rather than painting it all at once', async () => {
    const said = 'the quick brown fox jumps over the lazy dog'
    publisher.onChunk({ type: 'text-delta', id: 'b1', text: said })

    expect(tailOf(store)).toBe('')

    await sleep(A_FRAME_OR_TWO)

    const shown = tailOf(store)
    expect(shown.length).toBeGreaterThan(0)
    expect(shown.length).toBeLessThan(said.length)
    expect(said.startsWith(shown)).toBe(true)
  })

  it('delivers every character, in order', async () => {
    for (const text of ['alpha ', 'beta ', 'gamma ', 'delta']) {
      publisher.onChunk({ type: 'text-delta', id: 'b1', text })
    }

    await sleep(LONG_ENOUGH_TO_DRAIN)

    expect(tailOf(store)).toBe('alpha beta gamma delta')
  })

  it('keeps draining when no further delta arrives', async () => {
    publisher.onChunk({ type: 'text-delta', id: 'b1', text: 'x'.repeat(120) })

    await sleep(A_FRAME_OR_TWO)
    expect(tailOf(store).length).toBeLessThan(120)

    await sleep(LONG_ENOUGH_TO_DRAIN)
    expect(tailOf(store).length).toBe(120)
  })

  it('dumps a burst instead of typewriting through it', async () => {
    publisher.onChunk({ type: 'text-delta', id: 'b1', text: 'y'.repeat(5_000) })

    await sleep(A_FRAME_OR_TWO)

    expect(tailOf(store).length).toBe(5_000)
  })

  it('never splits a surrogate pair across frames', async () => {
    publisher.onChunk({ type: 'text-delta', id: 'b1', text: '🎈'.repeat(40) })

    for (let elapsed = 0; elapsed < LONG_ENOUGH_TO_DRAIN; elapsed += A_FRAME_OR_TWO) {
      await sleep(A_FRAME_OR_TWO)
      expect(tailOf(store)).toBe('🎈'.repeat([...tailOf(store)].length))
    }
  })

  it('snaps a finished block to full when the next one starts streaming', async () => {
    publisher.onChunk({ type: 'reasoning-delta', id: 'r1', text: 'considering the retry loop' })
    publisher.onChunk({ type: 'text-delta', id: 'b1', text: 'Here is what I found.' })

    await sleep(LONG_ENOUGH_TO_DRAIN)

    expect(store.getSnapshot().entries.map((entry) => entry.text)).toEqual([
      'considering the retry loop',
      'Here is what I found.',
    ])
  })

  it('shows the whole block the moment the step ends', () => {
    const durable = log([{ type: 'assistant-said', parts: [{ type: 'text', text: 'hi there' }] }])
    const reply = durable[0]
    if (reply === undefined) throw new Error('fixture lost its reply')

    publisher.onChunk({ type: 'text-delta', id: 'b1', text: 'hi there' })
    expect(tailOf(store)).toBe('')

    publisher.settleAppend({ events: [reply] })
    store.setEvents({ events: durable })

    expect(tailOf(store)).toBe('hi there')
  })

  it('stops ticking once disposed', async () => {
    publisher.onChunk({ type: 'text-delta', id: 'b1', text: 'z'.repeat(200) })
    store.dispose()

    await sleep(LONG_ENOUGH_TO_DRAIN)

    expect(tailOf(store)).toBe('')
  })
})
