import { beforeEach, describe, expect, it } from 'bun:test'

import { createDeltaChannel, type DeltaChannel } from '@dltech/atlas-harness'

import { createConversationStore, type ConversationStore } from '../conversation-store'
import { EEntryKind } from '../transcript-model'
import { fixtureThreadId, log } from './fixture'
import { called, callId, result } from './tool-fixture'

const liveOutputOf = (store: ConversationStore, n: number): string | undefined =>
  store
    .getSnapshot()
    .entries.filter((entry) => entry.kind === EEntryKind.ToolsRan)
    .flatMap((entry) => entry.run.calls)
    .find((call) => call.callId === callId(n))?.liveOutput

describe('what a running command has printed so far', () => {
  let channel: DeltaChannel
  let store: ConversationStore

  beforeEach(() => {
    channel = createDeltaChannel()
    store = createConversationStore({ channel, threadId: fixtureThreadId })
  })

  it('attaches the live tail to the call it belongs to', () => {
    store.setEvents({ events: log([called({ n: 1, name: 'bash', input: { command: 'bun run build' } })]),
    })

    channel
      .publisherFor({ threadId: fixtureThreadId })
      .toolOutput({ callId: callId(1), text: 'compiling 1/3\n' })

    expect(liveOutputOf(store, 1)).toBe('compiling 1/3\n')
  })

  it('grows the tail as more output streams', () => {
    store.setEvents({ events: log([called({ n: 1, name: 'bash' })]),
    })
    const publisher = channel.publisherFor({ threadId: fixtureThreadId })

    publisher.toolOutput({ callId: callId(1), text: 'compiling 1/3\n' })
    publisher.toolOutput({ callId: callId(1), text: 'compiling 2/3\n' })

    expect(liveOutputOf(store, 1)).toBe('compiling 1/3\ncompiling 2/3\n')
  })

  it('keeps parallel commands’ tails apart', () => {
    store.setEvents({
      events: log([called({ n: 1, name: 'bash' }), called({ n: 2, name: 'bash' })]),
    })
    const publisher = channel.publisherFor({ threadId: fixtureThreadId })

    publisher.toolOutput({ callId: callId(1), text: 'first\n' })
    publisher.toolOutput({ callId: callId(2), text: 'second\n' })

    expect(liveOutputOf(store, 1)).toBe('first\n')
    expect(liveOutputOf(store, 2)).toBe('second\n')
  })

  it('drops the tail once the call settles — the durable output takes over', () => {
    const publisher = channel.publisherFor({ threadId: fixtureThreadId })
    store.setEvents({ events: log([called({ n: 1, name: 'bash' })]),
    })
    publisher.toolOutput({ callId: callId(1), text: 'half way\n' })
    expect(liveOutputOf(store, 1)).toBe('half way\n')

    store.setEvents({
      events: log([
        called({ n: 1, name: 'bash' }),
        result({ n: 1, name: 'bash', output: { stdout: 'done\n' } }),
      ]),
    })

    expect(liveOutputOf(store, 1)).toBeUndefined()
  })

  it('ignores output for a call the log has never heard of', () => {
    channel
      .publisherFor({ threadId: fixtureThreadId })
      .toolOutput({ callId: callId(99), text: 'orphan\n' })

    expect(liveOutputOf(store, 99)).toBeUndefined()
  })

  it('leaves no tail behind on resetSteps, so a rewind leaves nothing half-printed', () => {
    store.setEvents({ events: log([called({ n: 1, name: 'bash' })]),
    })
    channel
      .publisherFor({ threadId: fixtureThreadId })
      .toolOutput({ callId: callId(1), text: 'half way\n' })
    expect(liveOutputOf(store, 1)).toBe('half way\n')

    store.resetSteps()

    expect(liveOutputOf(store, 1)).toBeUndefined()
  })
})
