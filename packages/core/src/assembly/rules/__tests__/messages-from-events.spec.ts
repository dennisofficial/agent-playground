import { describe, expect, it } from 'bun:test'

import { toCallId, toEventId } from '../../../events/ids'
import type { Assembled } from '../../assembled'
import { contextFor, log } from '../../__tests__/log-fixture'
import { messagesFromEvents } from '../messages-from-events'

const empty: Assembled = { system: [], messages: [] }

describe('messagesFromEvents', () => {
  it('renders a spoken exchange in log order, each message carrying its origin', () => {
    const events = log([
      { type: 'user-said', text: 'hello' },
      { type: 'assistant-said', parts: [{ type: 'text', text: 'hi there' }] },
    ])

    const assembled = messagesFromEvents()(empty, contextFor({ events }))

    expect(assembled.messages).toEqual([
      {
        message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        origin: { eventId: toEventId('event-1'), seq: 1 },
      },
      {
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
        origin: { eventId: toEventId('event-2'), seq: 2 },
      },
    ])
  })

  it('carries reasoning parts and their provider options through untouched', () => {
    const reasoning = {
      type: 'reasoning' as const,
      text: 'weighing the options',
      providerOptions: { anthropic: { signature: 'sig-abc' } },
    }
    const events = log([
      { type: 'user-said', text: 'why?' },
      { type: 'assistant-said', parts: [reasoning, { type: 'text', text: 'because' }] },
    ])

    const assembled = messagesFromEvents()(empty, contextFor({ events }))

    const assistant = assembled.messages[1]?.message
    expect(assistant?.role).toBe('assistant')
    expect(assistant?.content[0]).toEqual(reasoning)
    expect(assistant?.content[1]).toEqual({ type: 'text', text: 'because' })
  })

  it('ignores events that are not spoken turns', () => {
    const events = log([
      { type: 'user-said', text: 'run it' },
      { type: 'tool-called', callId: toCallId('call-1'), name: 'bash', input: { cmd: 'ls' }, ordinal: 0 },
      { type: 'tool-result', callId: toCallId('call-1'), name: 'bash', output: 'a.ts' },
      { type: 'context-loaded', slot: 'project', key: 'CLAUDE.md', content: 'rules' },
      { type: 'nudge', text: 'keep going', lifetimeSteps: 1 },
    ])

    const assembled = messagesFromEvents()(empty, contextFor({ events }))

    expect(assembled.messages.map((entry) => entry.message.role)).toEqual(['user'])
  })

  it('drops an assistant turn that holds no parts', () => {
    const events = log([{ type: 'assistant-said', parts: [], interrupted: true }])

    expect(messagesFromEvents()(empty, contextFor({ events })).messages).toEqual([])
  })

  it('leaves system blocks written by an earlier rule in place', () => {
    const seeded: Assembled = { system: [{ text: 'preamble' }], messages: [] }
    const events = log([{ type: 'user-said', text: 'hello' }])

    expect(messagesFromEvents()(seeded, contextFor({ events })).system).toEqual([{ text: 'preamble' }])
  })
})
