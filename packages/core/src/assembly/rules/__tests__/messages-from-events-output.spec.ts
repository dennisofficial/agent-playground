import { describe, expect, it } from 'bun:test'

import { toCallId } from '../../../events/ids'
import type { Assembled } from '../../assembled'
import { contextFor, log } from '../../__tests__/log-fixture'
import { messagesFromEvents } from '../messages-from-events'

const empty: Assembled = { system: [], messages: [] }

describe('messagesFromEvents rendering a tool result', () => {
  const settled = (output: unknown) =>
    log([
      { type: 'tool-called', callId: toCallId('call-1'), name: 'write', input: { path: 'a.ts' }, ordinal: 0 },
      { type: 'tool-result', callId: toCallId('call-1'), name: 'write', output },
    ])


  const outputOf = (events: ReturnType<typeof log>) =>
    messagesFromEvents()(empty, contextFor({ events })).messages[1]?.message.content[0]


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
})

describe('messagesFromEvents rendering a tool result that carries parts', () => {
  const withParts = (modelParts: readonly ({ type: 'text'; text: string } | { type: 'image'; data: string; mediaType: string })[]) =>
    log([
      { type: 'tool-called', callId: toCallId('call-1'), name: 'read', input: { path: 'shot.png' }, ordinal: 0 },
      {
        type: 'tool-result',
        callId: toCallId('call-1'),
        name: 'read',
        output: { path: 'shot.png', inlined: true },
        modelText: 'shot.png — image/png, 8×8, 1 KB.',
        modelParts,
      },
    ])

  const contentOf = (events: ReturnType<typeof log>) =>
    messagesFromEvents()(empty, contextFor({ events })).messages[1]?.message.content[0]

  it('hands the model the parts rather than the summary text', () => {
    const parts = [
      { type: 'text' as const, text: 'shot.png — image/png, 8×8, 1 KB.' },
      { type: 'image' as const, data: 'iVBOR', mediaType: 'image/png' },
    ]

    expect(contentOf(withParts(parts))).toMatchObject({ output: { type: 'content', value: parts } })
  })

  it('falls back to the summary text when the parts are empty', () => {
    expect(contentOf(withParts([]))).toMatchObject({
      output: { type: 'text', value: 'shot.png — image/png, 8×8, 1 KB.' },
    })
  })
})
