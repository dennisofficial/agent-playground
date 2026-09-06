import { describe, expect, it } from 'bun:test'

import { toCallId, toThreadId } from '@dltech/atlas-core'

import { createDeltaChannel } from '..'
import { recorder } from './signals'

const threadId = toThreadId('thread-1')
const callId = toCallId('call-1')

describe('tool output between steps', () => {
  it('publishes each chunk keyed by the call that printed it, stamped with no step', () => {
    const channel = createDeltaChannel()
    const { seen, listener } = recorder()
    channel.subscribe({ threadId, listener })
    const publisher = channel.publisherFor({ threadId })

    publisher.toolOutput({ callId, text: 'compiling\n' })
    publisher.toolOutput({ callId: toCallId('call-2'), text: 'linking\n' })

    expect(seen).toEqual([
      { type: 'tool-output', callId, text: 'compiling\n' },
      { type: 'tool-output', callId: toCallId('call-2'), text: 'linking\n' },
    ])
  })

  it('is part of what a late subscriber replays while it is still in flight', () => {
    const channel = createDeltaChannel()
    channel.publisherFor({ threadId }).toolOutput({ callId, text: 'compiling\n' })

    expect(channel.snapshot({ threadId })).toEqual([
      { type: 'tool-output', callId, text: 'compiling\n' },
    ])

    const late = recorder()
    channel.subscribe({ threadId, listener: late.listener })
    expect(late.seen).toEqual([{ type: 'tool-output', callId, text: 'compiling\n' }])
  })

  it('yields the replay to the next step once one starts, like any in-flight signal', () => {
    const channel = createDeltaChannel()
    const publisher = channel.publisherFor({ threadId })
    publisher.toolOutput({ callId, text: 'compiling\n' })

    publisher.onChunk({ type: 'text-delta', id: 't1', text: 'done' })

    expect(channel.snapshot({ threadId }).map((signal) => signal.type)).toEqual([
      'step-started',
      'chunk',
    ])
  })
})
