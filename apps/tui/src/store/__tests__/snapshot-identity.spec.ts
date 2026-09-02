import { beforeEach, describe, expect, it } from 'bun:test'

import { createDeltaChannel, type DeltaChannel } from '@dltech/atlas-harness'

import { createConversationStore, type ConversationStore } from '../conversation-store'
import { IDLE_TURN } from '../../ui/components/transcript'
import { fixtureThreadId, log } from './fixture'

const conversation = log([
  { type: 'user-said', text: 'why is this slow' },
  { type: 'assistant-said', parts: [{ type: 'text', text: 'because every entry re-renders' }] },
  { type: 'user-said', text: 'fix it' },
])

/**
 * The transcript is what React re-renders, and it re-renders per entry. These are the identities a
 * memoised row depends on: re-deriving the same log must not churn them, and a clock that only the
 * sidebar reads must not touch the transcript at all.
 */
describe('snapshot identity', () => {
  let channel: DeltaChannel
  let store: ConversationStore

  beforeEach(() => {
    channel = createDeltaChannel()
    store = createConversationStore({ channel, threadId: fixtureThreadId, events: conversation })
  })

  it('keeps every entry when the same log is set again', () => {
    const before = store.getSnapshot()

    store.setEvents({ events: [...conversation] })

    expect(store.getSnapshot().entries).toBe(before.entries)
  })

  it('keeps the entries that did not move when the log grows', () => {
    const before = store.getSnapshot()
    expect(before.entries.length).toBeGreaterThan(0)

    store.setEvents({
      events: log([
        { type: 'user-said', text: 'why is this slow' },
        {
          type: 'assistant-said',
          parts: [{ type: 'text', text: 'because every entry re-renders' }],
        },
        { type: 'user-said', text: 'fix it' },
        { type: 'assistant-said', parts: [{ type: 'text', text: 'measuring first' }] },
      ]),
    })

    const after = store.getSnapshot()
    expect(after.entries).not.toBe(before.entries)
    expect(after.entries.length).toBe(before.entries.length + 1)
    for (const [index, entry] of before.entries.entries()) {
      expect(after.entries[index]).toBe(entry)
    }
  })

  it('leaves the transcript snapshot untouched when only the turn clock advanced', () => {
    const before = store.getSnapshot()

    store.setTurn({ ...IDLE_TURN, startedAt: 1000, outputTokens: 12 })

    expect(store.getSnapshot()).toBe(before)
  })

  it('still tells the sidebar that the turn clock advanced', () => {
    const before = store.getSidebar()

    store.setTurn({ ...IDLE_TURN, startedAt: 1000, outputTokens: 12 })

    expect(store.getSidebar()).not.toBe(before)
  })

  it('wakes its listeners for a turn the sidebar alone cares about', () => {
    let woke = 0
    store.subscribe(() => {
      woke += 1
    })

    store.setTurn({ ...IDLE_TURN, startedAt: 1000, outputTokens: 12 })

    expect(woke).toBe(1)
  })
})
