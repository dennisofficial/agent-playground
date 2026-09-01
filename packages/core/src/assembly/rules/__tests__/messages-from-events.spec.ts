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

  it('appends a tool call to the assistant message it was emitted with', () => {
    const events = log([
      { type: 'assistant-said', parts: [{ type: 'text', text: 'listing' }] },
      { type: 'tool-called', callId: toCallId('call-1'), name: 'bash', input: { cmd: 'ls' }, ordinal: 0 },
    ])

    const assembled = messagesFromEvents()(empty, contextFor({ events }))

    expect(assembled.messages[0]).toEqual({
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'listing' },
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'bash', input: { cmd: 'ls' } },
        ],
      },
      origin: { eventId: toEventId('event-1'), seq: 1 },
    })
    expect(assembled.messages[1]?.message.role).toBe('tool')
  })

  it('renders a settled call as a tool message carrying its text output', () => {
    const events = log([
      { type: 'tool-called', callId: toCallId('call-1'), name: 'bash', input: { cmd: 'ls' }, ordinal: 0 },
      { type: 'tool-result', callId: toCallId('call-1'), name: 'bash', output: 'a.ts' },
    ])

    const assembled = messagesFromEvents()(empty, contextFor({ events }))

    expect(assembled.messages[1]).toEqual({
      message: {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'bash',
            output: { type: 'text', value: 'a.ts' },
          },
        ],
      },
      origin: { eventId: toEventId('event-2'), seq: 2 },
    })
  })

  it('coalesces consecutive settlements, denials included, into one tool message', () => {
    const events = log([
      { type: 'tool-called', callId: toCallId('call-1'), name: 'glob', input: { pattern: '*' }, ordinal: 0 },
      { type: 'tool-called', callId: toCallId('call-2'), name: 'bash', input: { command: 'rm -rf /' }, ordinal: 1 },
      { type: 'tool-result', callId: toCallId('call-1'), name: 'glob', output: 'a.ts' },
      { type: 'tool-denied', callId: toCallId('call-2'), name: 'bash', reason: 'outside the workspace root' },
    ])

    const assembled = messagesFromEvents()(empty, contextFor({ events }))

    expect(assembled.messages).toHaveLength(2)
    expect(assembled.messages[1]?.message).toEqual({
      role: 'tool',
      content: [
        { type: 'tool-result', toolCallId: 'call-1', toolName: 'glob', output: { type: 'text', value: 'a.ts' } },
        {
          type: 'tool-result',
          toolCallId: 'call-2',
          toolName: 'bash',
          output: { type: 'error-text', value: 'outside the workspace root' },
        },
      ],
    })
    expect(assembled.messages[1]?.origin).toEqual({ eventId: toEventId('event-3'), seq: 3 })
  })

  it('starts a new group when the assistant speaks between settlements', () => {
    const events = log([
      { type: 'tool-called', callId: toCallId('call-1'), name: 'glob', input: { pattern: '*' }, ordinal: 0 },
      { type: 'tool-result', callId: toCallId('call-1'), name: 'glob', output: 'a.ts' },
      { type: 'assistant-said', parts: [{ type: 'text', text: 'now reading it' }] },
      { type: 'tool-called', callId: toCallId('call-2'), name: 'read', input: { path: 'a.ts' }, ordinal: 0 },
      { type: 'tool-result', callId: toCallId('call-2'), name: 'read', output: 'export {}' },
    ])

    const assembled = messagesFromEvents()(empty, contextFor({ events }))

    expect(assembled.messages.map((entry) => entry.message.role)).toEqual([
      'assistant',
      'tool',
      'assistant',
      'tool',
    ])
    expect(assembled.messages[2]?.message.content).toEqual([
      { type: 'text', text: 'now reading it' },
      { type: 'tool-call', toolCallId: 'call-2', toolName: 'read', input: { path: 'a.ts' } },
    ])
    expect(assembled.messages[3]?.message.content).toEqual([
      { type: 'tool-result', toolCallId: 'call-2', toolName: 'read', output: { type: 'text', value: 'export {}' } },
    ])
  })

  it('renders loaded context as a user message, and a live nudge after it', () => {
    const events = log([
      { type: 'user-said', text: 'run it' },
      { type: 'context-loaded', slot: 'project-instructions', key: '/repo/CLAUDE.md', content: 'rules' },
      { type: 'nudge', text: 'keep going', lifetimeSteps: 1 },
    ])

    const assembled = messagesFromEvents()(empty, contextFor({ events }))

    expect(assembled.messages.map((entry) => entry.message.role)).toEqual(['user', 'user', 'user'])
    expect(assembled.messages[1]?.message.content).toEqual([
      {
        type: 'text',
        text: [
          '<system-reminder>',
          'Contents of /repo/CLAUDE.md (project instructions, checked into the codebase):',
          '',
          'rules',
          '</system-reminder>',
        ].join('\n'),
      },
    ])
  })

  it('renders only the latest load of a file, so a re-read supersedes rather than repeats', () => {
    const events = log([
      { type: 'context-loaded', slot: 'project-instructions', key: '/repo/CLAUDE.md', content: 'old rules' },
      { type: 'user-said', text: 'run it' },
      { type: 'context-loaded', slot: 'project-instructions', key: '/repo/CLAUDE.md', content: 'new rules' },
    ])

    const rendered = messagesFromEvents()(empty, contextFor({ events })).messages.flatMap((entry) =>
      entry.message.role === 'user'
        ? entry.message.content.flatMap((part) => (part.type === 'text' ? [part.text] : []))
        : [],
    )

    expect(rendered.filter((text) => text.includes('old rules'))).toEqual([])
    expect(rendered.filter((text) => text.includes('new rules'))).toHaveLength(1)
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

describe('messagesFromEvents and nudges', () => {
  it('renders a live nudge as a user-role block, so the prompt no longer ends on the model', () => {
    const events = log([
      { type: 'user-said', text: 'explain' },
      { type: 'assistant-said', parts: [{ type: 'text', text: 'it works by' }], interrupted: true },
      { type: 'nudge', text: 'carry on', lifetimeSteps: 1 },
    ])

    const assembled = messagesFromEvents()(empty, contextFor({ events }))

    expect(assembled.messages.at(-1)).toEqual({
      message: { role: 'user', content: [{ type: 'text', text: '<nudge>\ncarry on\n</nudge>' }] },
      origin: { eventId: toEventId('event-3'), seq: 3 },
    })
  })

  it('drops a nudge the model has already answered', () => {
    const events = log([
      { type: 'user-said', text: 'explain' },
      { type: 'nudge', text: 'carry on', lifetimeSteps: 1 },
      { type: 'assistant-said', parts: [{ type: 'text', text: 'carried' }] },
    ])

    const assembled = messagesFromEvents()(empty, contextFor({ events }))

    expect(assembled.messages.map((entry) => entry.message.role)).toEqual(['user', 'assistant'])
  })
})
