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

    expect(assembled.messages).toEqual([
      {
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'listing' },
            { type: 'tool-call', toolCallId: 'call-1', toolName: 'bash', input: { cmd: 'ls' } },
          ],
        },
        origin: { eventId: toEventId('event-1'), seq: 1 },
      },
    ])
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

  it('renders a failed call as error text the model can read', () => {
    const events = log([
      { type: 'tool-called', callId: toCallId('call-1'), name: 'read', input: { path: 'gone.ts' }, ordinal: 0 },
      {
        type: 'tool-result',
        callId: toCallId('call-1'),
        name: 'read',
        output: undefined,
        error: { message: 'no such file' },
      },
    ])

    const assembled = messagesFromEvents()(empty, contextFor({ events }))

    expect(assembled.messages[1]?.message.content).toEqual([
      {
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'read',
        output: { type: 'error-text', value: 'no such file' },
      },
    ])
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

  it('renders a structured output as text rather than proving it is JSON', () => {
    const events = log([
      { type: 'tool-called', callId: toCallId('call-1'), name: 'edit', input: { path: 'a.ts' }, ordinal: 0 },
      { type: 'tool-result', callId: toCallId('call-1'), name: 'edit', output: { replacements: 2 } },
    ])

    const assembled = messagesFromEvents()(empty, contextFor({ events }))

    expect(assembled.messages[1]?.message.content).toEqual([
      {
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'edit',
        output: { type: 'text', value: '{"replacements":2}' },
      },
    ])
  })

  it('projects a full multi-step exchange, unsettled call included', () => {
    const events = log([
      { type: 'user-said', text: 'find and fix it' },
      { type: 'assistant-said', parts: [{ type: 'text', text: 'searching' }] },
      { type: 'tool-called', callId: toCallId('call-1'), name: 'grep', input: { pattern: 'todo' }, ordinal: 0 },
      { type: 'tool-called', callId: toCallId('call-2'), name: 'glob', input: { pattern: '*.ts' }, ordinal: 1 },
      { type: 'tool-result', callId: toCallId('call-1'), name: 'grep', output: 'a.ts:1: todo' },
      { type: 'tool-result', callId: toCallId('call-2'), name: 'glob', output: 'a.ts' },
      { type: 'assistant-said', parts: [{ type: 'text', text: 'now editing' }] },
      { type: 'tool-called', callId: toCallId('call-3'), name: 'bash', input: { command: 'rm a.ts' }, ordinal: 0 },
      { type: 'tool-denied', callId: toCallId('call-3'), name: 'bash', reason: 'destructive' },
      { type: 'tool-called', callId: toCallId('call-4'), name: 'write', input: { path: 'a.ts' }, ordinal: 0 },
    ])

    const assembled = messagesFromEvents()(empty, contextFor({ events }))

    expect(assembled.messages).toEqual([
      {
        message: { role: 'user', content: [{ type: 'text', text: 'find and fix it' }] },
        origin: { eventId: toEventId('event-1'), seq: 1 },
      },
      {
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'searching' },
            { type: 'tool-call', toolCallId: 'call-1', toolName: 'grep', input: { pattern: 'todo' } },
            { type: 'tool-call', toolCallId: 'call-2', toolName: 'glob', input: { pattern: '*.ts' } },
          ],
        },
        origin: { eventId: toEventId('event-2'), seq: 2 },
      },
      {
        message: {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-1',
              toolName: 'grep',
              output: { type: 'text', value: 'a.ts:1: todo' },
            },
            {
              type: 'tool-result',
              toolCallId: 'call-2',
              toolName: 'glob',
              output: { type: 'text', value: 'a.ts' },
            },
          ],
        },
        origin: { eventId: toEventId('event-5'), seq: 5 },
      },
      {
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'now editing' },
            { type: 'tool-call', toolCallId: 'call-3', toolName: 'bash', input: { command: 'rm a.ts' } },
          ],
        },
        origin: { eventId: toEventId('event-7'), seq: 7 },
      },
      {
        message: {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-3',
              toolName: 'bash',
              output: { type: 'error-text', value: 'destructive' },
            },
          ],
        },
        origin: { eventId: toEventId('event-9'), seq: 9 },
      },
      {
        message: {
          role: 'assistant',
          content: [{ type: 'tool-call', toolCallId: 'call-4', toolName: 'write', input: { path: 'a.ts' } }],
        },
        origin: { eventId: toEventId('event-10'), seq: 10 },
      },
    ])
  })

  const settled = (output: unknown) =>
    log([
      { type: 'tool-called', callId: toCallId('call-1'), name: 'write', input: { path: 'a.ts' }, ordinal: 0 },
      { type: 'tool-result', callId: toCallId('call-1'), name: 'write', output },
    ])

  const outputOf = (events: ReturnType<typeof log>) =>
    messagesFromEvents()(empty, contextFor({ events })).messages[1]?.message.content[0]

  it('renders modelText rather than the structured output the TUI reads', () => {
    const events = log([
      { type: 'tool-called', callId: toCallId('call-1'), name: 'edit', input: { path: 'a.ts' }, ordinal: 0 },
      {
        type: 'tool-result',
        callId: toCallId('call-1'),
        name: 'edit',
        output: { diff: '@@ -1 +1 @@\n-old\n+new', hunks: 1 },
        modelText: 'The file a.ts has been updated successfully.',
      },
    ])

    const assembled = messagesFromEvents()(empty, contextFor({ events }))

    expect(assembled.messages[1]?.message.content).toEqual([
      {
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'edit',
        output: { type: 'text', value: 'The file a.ts has been updated successfully.' },
      },
    ])
  })

  it('keeps an error louder than modelText when a producer sets both', () => {
    const events = log([
      { type: 'tool-called', callId: toCallId('call-1'), name: 'edit', input: { path: 'a.ts' }, ordinal: 0 },
      {
        type: 'tool-result',
        callId: toCallId('call-1'),
        name: 'edit',
        output: undefined,
        modelText: 'updated successfully',
        error: { message: 'oldString was not found' },
      },
    ])

    const assembled = messagesFromEvents()(empty, contextFor({ events }))

    expect(assembled.messages[1]?.message.content[0]).toMatchObject({
      output: { type: 'error-text', value: 'oldString was not found' },
    })
  })

  it('renders an empty modelText as readable text rather than an empty block', () => {
    const events = log([
      { type: 'tool-called', callId: toCallId('call-1'), name: 'write', input: { path: 'a.ts' }, ordinal: 0 },
      { type: 'tool-result', callId: toCallId('call-1'), name: 'write', output: 'ignored', modelText: '' },
    ])

    const assembled = messagesFromEvents()(empty, contextFor({ events }))

    expect(assembled.messages[1]?.message.content[0]).toMatchObject({
      output: { type: 'text', value: '(no output)' },
    })
  })

  it('renders a success with nothing to say as readable text, not an empty block', () => {
    expect(outputOf(settled(undefined))).toMatchObject({ output: { type: 'text', value: '(no output)' } })
    expect(outputOf(settled(null))).toMatchObject({ output: { type: 'text', value: '(no output)' } })
    expect(outputOf(settled('   '))).toMatchObject({ output: { type: 'text', value: '(no output)' } })
  })

  it('describes an output JSON cannot serialise rather than throwing the rule away', () => {
    const circular: { self?: unknown } = {}
    circular.self = circular

    expect(outputOf(settled(circular))).toMatchObject({
      output: { type: 'text', value: '(unrenderable object output)' },
    })
    expect(outputOf(settled(() => 'nope'))).toMatchObject({
      output: { type: 'text', value: '(unrenderable function output)' },
    })
  })

  it('renders a bigint output, which JSON.stringify refuses to touch', () => {
    expect(outputOf(settled(9007199254740993n))).toMatchObject({
      output: { type: 'text', value: '9007199254740993' },
    })
  })

  it('renders a non-finite number as itself rather than as JSON null', () => {
    expect(outputOf(settled(Number.POSITIVE_INFINITY))).toMatchObject({
      output: { type: 'text', value: 'Infinity' },
    })
    expect(outputOf(settled(Number.NaN))).toMatchObject({ output: { type: 'text', value: 'NaN' } })
  })

  it('ignores context and nudge events, which later slices render', () => {
    const events = log([
      { type: 'user-said', text: 'run it' },
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
