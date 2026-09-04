import { describe, expect, it } from 'bun:test'

import { EDecision, type EventDraft } from '../../../events/body'
import { toCallId, toEventId } from '../../../events/ids'
import type { Assembled } from '../../assembled'
import { exchangeFaults } from '../../exchange-shape'
import { contextFor, log } from '../../__tests__/log-fixture'
import { messagesFromEvents } from '../messages-from-events'

const empty: Assembled = { system: [], messages: [] }

describe('messagesFromEvents pairing every call with a result', () => {
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
      {
        message: {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-4',
              toolName: 'write',
              output: { type: 'error-text', value: 'This tool call did not complete and produced no result.' },
            },
          ],
        },
        origin: { eventId: toEventId('event-10'), seq: 10 },
      },
    ])
  })

  it('answers every call in an assistant message even when a user turn split the settlements', async () => {
    const events = log([
      { type: 'user-said', text: 'find them' },
      { type: 'assistant-said', parts: [{ type: 'text', text: 'searching' }] },
      { type: 'tool-called', callId: toCallId('call-0'), name: 'grep', input: { pattern: 'a' }, ordinal: 0 },
      { type: 'tool-called', callId: toCallId('call-1'), name: 'glob', input: { pattern: 'b' }, ordinal: 1 },
      { type: 'tool-result', callId: toCallId('call-0'), name: 'grep', output: 'hit', modelText: 'hit' },
      { type: 'user-said', text: 'actually stop' },
      { type: 'tool-result', callId: toCallId('call-1'), name: 'glob', output: 'b.ts', modelText: 'b.ts' },
    ])

    const assembled = messagesFromEvents()(empty, contextFor({ events }))

    expect(assembled.messages.map((entry) => entry.message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'user',
    ])
    const results = assembled.messages[2]?.message.content
    expect(results?.map((part) => (part.type === 'tool-result' ? part.toolCallId : undefined))).toEqual([
      'call-0',
      'call-1',
    ])
  })

  it('synthesises a result for a call that never settled, which the API demands', async () => {
    const events = log([
      { type: 'assistant-said', parts: [{ type: 'text', text: 'reading' }] },
      { type: 'tool-called', callId: toCallId('call-0'), name: 'read', input: { path: 'a' }, ordinal: 0 },
    ])

    const assembled = messagesFromEvents()(empty, contextFor({ events }))

    expect(assembled.messages.map((entry) => entry.message.role)).toEqual(['assistant', 'tool'])
    expect(assembled.messages[1]?.message.content[0]).toMatchObject({
      type: 'tool-result',
      toolCallId: 'call-0',
      output: { type: 'error-text' },
    })
  })

  it('never leaves a tool call unanswered, whatever order the log puts events in', () => {
    const call = (id: string, ordinal: number) =>
      ({ type: 'tool-called', callId: toCallId(id), name: 'read', input: { path: id }, ordinal }) as const
    const result = (id: string) =>
      ({ type: 'tool-result', callId: toCallId(id), name: 'read', output: 'x', modelText: 'x' }) as const
    const said = { type: 'assistant-said', parts: [{ type: 'text', text: 'working' }] } as const
    const asked = { type: 'user-said', text: 'go' } as const

    const logs: EventDraft[][] = [
      [asked, said, call('c0', 0), call('c1', 1), result('c0'), asked, result('c1')],
      [said, call('c0', 0), asked, result('c0')],
      [said, call('c0', 0)],
      [said, call('c0', 0), call('c1', 1)],
      [said, call('c0', 0), result('c0'), call('c1', 0), result('c1')],
      [result('c9'), said, call('c0', 0), result('c0')],
      [asked, said, call('c0', 0), result('c0'), said, asked, call('c1', 0)],
    ]

    for (const drafts of logs) {
      const messages = messagesFromEvents()(empty, contextFor({ events: log(drafts) })).messages

      messages.forEach((entry, index) => {
        const calls = entry.message.content.flatMap((part) =>
          part.type === 'tool-call' ? [part.toolCallId] : [],
        )
        if (calls.length === 0) return

        const next = messages[index + 1]?.message
        expect(next?.role).toBe('tool')
        expect(next?.content.flatMap((part) => (part.type === 'tool-result' ? [part.toolCallId] : []))).toEqual(
          calls,
        )
      })

      const roles = messages.map((entry) => entry.message.role)
      roles.forEach((role, index) => {
        if (role !== 'tool') return
        expect(messages[index - 1]?.message.role).toBe('assistant')
      })
    }
  })

  it('keeps one turn\'s results together whatever the log interleaves between them', () => {
    const interlopers: EventDraft[] = [
      { type: 'context-loaded', slot: 'project', key: 'CLAUDE.md', content: 'rules' },
      { type: 'nudge', text: 'keep going', lifetimeSteps: 1 },
      { type: 'approval-requested', callId: toCallId('call-1'), reason: 'destructive' },
      { type: 'approval-answered', callId: toCallId('call-1'), decision: EDecision.Allow },
      { type: 'user-said', text: 'actually stop' },
    ]

    for (const interloper of interlopers) {
      const events = log([
        { type: 'assistant-said', parts: [{ type: 'text', text: 'working' }] },
        { type: 'tool-called', callId: toCallId('call-0'), name: 'read', input: { path: 'a' }, ordinal: 0 },
        { type: 'tool-called', callId: toCallId('call-1'), name: 'read', input: { path: 'b' }, ordinal: 1 },
        { type: 'tool-result', callId: toCallId('call-0'), name: 'read', output: 'a', modelText: 'a' },
        interloper,
        { type: 'tool-result', callId: toCallId('call-1'), name: 'read', output: 'b', modelText: 'b' },
      ])

      const messages = messagesFromEvents()(empty, contextFor({ events })).messages
      const toolMessages = messages.filter((entry) => entry.message.role === 'tool')

      expect(toolMessages).toHaveLength(1)
      expect(
        toolMessages[0]?.message.content.flatMap((part) =>
          part.type === 'tool-result' ? [part.toolCallId] : [],
        ),
      ).toEqual(['call-0', 'call-1'])

      const toolIndex = messages.findIndex((entry) => entry.message.role === 'tool')
      expect(messages[toolIndex - 1]?.message.role).toBe('assistant')
    }
  })

  it('renames a call id the log repeats within a step rather than dropping the call', () => {
    const events = log([
      { type: 'user-said', text: 'go' },
      { type: 'assistant-said', parts: [{ type: 'text', text: 'working' }] },
      { type: 'tool-called', callId: toCallId('call-0'), name: 'read', input: { path: 'a' }, ordinal: 0 },
      { type: 'tool-called', callId: toCallId('call-0'), name: 'read', input: { path: 'b' }, ordinal: 1 },
      { type: 'tool-result', callId: toCallId('call-0'), name: 'read', output: 'a', modelText: 'a' },
    ])

    const assembled = messagesFromEvents()(empty, contextFor({ events }))

    const calls = assembled.messages.flatMap((entry) =>
      entry.message.content.flatMap((part) => (part.type === 'tool-call' ? [part] : [])),
    )
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ toolCallId: 'call-0', input: { path: 'a' } })
    expect(calls[1]).toMatchObject({ toolCallId: 'call-0~2', input: { path: 'b' } })

    const results = assembled.messages.flatMap((entry) =>
      entry.message.content.flatMap((part) => (part.type === 'tool-result' ? [part] : [])),
    )
    expect(results.map((part) => part.toolCallId)).toEqual(['call-0', 'call-0~2'])
    expect(results[1]?.output).toEqual({ type: 'text', value: 'a' })
    expect(exchangeFaults(assembled)).toEqual([])
  })

  it('keeps both calls when a compacted thread calls the same id again, settling each in turn', () => {
    const events = log([
      { type: 'user-said', text: 'clean up' },
      { type: 'assistant-said', parts: [{ type: 'text', text: 'on it' }] },
      { type: 'tool-called', callId: toCallId('bash_419'), name: 'bash', input: { command: 'first' }, ordinal: 0 },
      { type: 'tool-result', callId: toCallId('bash_419'), name: 'bash', output: 'first done', modelText: 'first done' },
      { type: 'assistant-said', parts: [{ type: 'text', text: 'finishing the cleanup' }] },
      { type: 'tool-called', callId: toCallId('bash_419'), name: 'bash', input: { command: 'second' }, ordinal: 0 },
      { type: 'tool-result', callId: toCallId('bash_419'), name: 'bash', output: 'second done', modelText: 'second done' },
    ])

    const assembled = messagesFromEvents()(empty, contextFor({ events }))

    expect(assembled.messages.map((entry) => entry.message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'tool',
    ])
    expect(assembled.messages[1]?.message.content).toContainEqual({
      type: 'tool-call',
      toolCallId: 'bash_419',
      toolName: 'bash',
      input: { command: 'first' },
    })
    expect(assembled.messages[3]?.message.content).toContainEqual({
      type: 'tool-call',
      toolCallId: 'bash_419~2',
      toolName: 'bash',
      input: { command: 'second' },
    })
    expect(assembled.messages[2]?.message.content[0]).toMatchObject({
      toolCallId: 'bash_419',
      output: { type: 'text', value: 'first done' },
    })
    expect(assembled.messages[4]?.message.content[0]).toMatchObject({
      toolCallId: 'bash_419~2',
      output: { type: 'text', value: 'second done' },
    })
    expect(exchangeFaults(assembled)).toEqual([])
  })

  it('renames the later call when the log repeats an id across turns', () => {
    const events = log([
      { type: 'user-said', text: 'go' },
      { type: 'assistant-said', parts: [{ type: 'text', text: 'first' }] },
      { type: 'tool-called', callId: toCallId('call-0'), name: 'read', input: { path: 'a' }, ordinal: 0 },
      { type: 'tool-result', callId: toCallId('call-0'), name: 'read', output: 'a', modelText: 'a' },
      { type: 'assistant-said', parts: [{ type: 'text', text: 'second' }] },
      { type: 'tool-called', callId: toCallId('call-0'), name: 'read', input: { path: 'a' }, ordinal: 0 },
      { type: 'user-said', text: 'go on' },
    ])

    const assembled = messagesFromEvents()(empty, contextFor({ events }))

    expect(assembled.messages.map((entry) => entry.message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'tool',
      'user',
    ])
    expect(assembled.messages[3]?.message.content).toEqual([
      { type: 'text', text: 'second' },
      { type: 'tool-call', toolCallId: 'call-0~2', toolName: 'read', input: { path: 'a' } },
    ])
    expect(assembled.messages[4]?.message.content[0]).toMatchObject({
      type: 'tool-result',
      toolCallId: 'call-0~2',
      output: { type: 'error-text', value: 'This tool call did not complete and produced no result.' },
    })
    expect(exchangeFaults(assembled)).toEqual([])
  })

  it('lets the latest settlement of a call supersede an earlier one', () => {
    const events = log([
      { type: 'user-said', text: 'go' },
      { type: 'assistant-said', parts: [{ type: 'text', text: 'working' }] },
      { type: 'tool-called', callId: toCallId('call-0'), name: 'bash', input: { command: 'x' }, ordinal: 0 },
      { type: 'tool-denied', callId: toCallId('call-0'), name: 'bash', reason: 'needs approval' },
      { type: 'tool-result', callId: toCallId('call-0'), name: 'bash', output: 'ran', modelText: 'ran' },
    ])

    const assembled = messagesFromEvents()(empty, contextFor({ events }))

    const results = assembled.messages.flatMap((entry) =>
      entry.message.content.flatMap((part) => (part.type === 'tool-result' ? [part] : [])),
    )
    expect(results).toHaveLength(1)
    expect(results[0]?.output).toEqual({ type: 'text', value: 'ran' })
    expect(exchangeFaults(assembled)).toEqual([])
  })
})
