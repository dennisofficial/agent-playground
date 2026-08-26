import { describe, expect, it } from 'bun:test'

import type { EventRef } from '../../events/envelope'
import { toEventId } from '../../events/ids'
import type { AssistantMessage, Message, ToolMessage } from '../../message/message'
import type { TextPart, ToolCallPart, ToolResultPart } from '../../message/parts'
import type { Assembled } from '../assembled'
import { EExchangeFault, exchangeFaults } from '../exchange-shape'

const originAt = (index: number): EventRef => ({
  eventId: toEventId(`event-${index + 1}`),
  seq: index + 1,
})

const exchange = (messages: readonly Message[]): Assembled => ({
  system: [{ text: 'preamble' }],
  messages: messages.map((message, index) => ({ message, origin: originAt(index) })),
})

const text = (value: string): TextPart => ({ type: 'text', text: value })

const user = (value: string): Message => ({ role: 'user', content: [text(value)] })

const assistant = (content: AssistantMessage['content']): Message => ({ role: 'assistant', content })

const settlement = (content: ToolMessage['content']): Message => ({ role: 'tool', content })

const call = (toolCallId: string): ToolCallPart => ({
  type: 'tool-call',
  toolCallId,
  toolName: 'read',
  input: { path: 'a.ts' },
})

const result = (toolCallId: string): ToolResultPart => ({
  type: 'tool-result',
  toolCallId,
  toolName: 'read',
  output: { type: 'text', value: 'export const a = 1' },
})

const kindsOf = (assembled: Assembled): EExchangeFault[] =>
  exchangeFaults(assembled).map((entry) => entry.fault)

describe('an exchange the provider accepts', () => {
  it('reports nothing for a plain spoken exchange', () => {
    expect(exchangeFaults(exchange([user('hello'), assistant([text('hi there')])]))).toEqual([])
  })

  it('reports nothing for a call answered in the turn that follows it', () => {
    const assembled = exchange([
      user('what is in a.ts?'),
      assistant([text('reading'), call('c0'), call('c1')]),
      settlement([result('c0'), result('c1')]),
      assistant([text('one export')]),
    ])

    expect(exchangeFaults(assembled)).toEqual([])
  })

  it('reports nothing when two tool messages answer one assistant turn between them', () => {
    const assembled = exchange([
      user('go'),
      assistant([call('c0'), call('c1')]),
      settlement([result('c0')]),
      settlement([result('c1')]),
    ])

    expect(exchangeFaults(assembled)).toEqual([])
  })

  it('reports nothing when a call part precedes text in the assistant message', () => {
    const assembled = exchange([
      user('go'),
      assistant([call('c0'), text('done')]),
      settlement([result('c0')]),
    ])

    expect(exchangeFaults(assembled)).toEqual([])
  })

  it('reports nothing for an exchange holding no messages', () => {
    expect(exchangeFaults({ system: [], messages: [] })).toEqual([])
  })
})

describe('a settlement split by an intervening message', () => {
  const interrupted = exchange([
    user('fix it'),
    assistant([text('working'), call('c0'), call('c1')]),
    settlement([result('c0')]),
    user('actually do something else'),
    settlement([result('c1')]),
  ])

  it('names the result that the provider would place after other content', () => {
    expect(exchangeFaults(interrupted)).toEqual([
      {
        fault: EExchangeFault.ResultAfterOtherContent,
        messageIndex: 4,
        origin: originAt(4),
        toolCallId: 'c1',
        detail: expect.stringContaining('c1'),
      },
    ])
  })

  it('does not call the split call unanswered, because its result is present', () => {
    expect(kindsOf(interrupted)).not.toContain(EExchangeFault.UnansweredCall)
  })

  it('faults a result placed after text in the same turn', () => {
    const assembled = exchange([
      user('go'),
      assistant([call('c0')]),
      user('and also this'),
      settlement([result('c0')]),
    ])

    expect(kindsOf(assembled)).toEqual([EExchangeFault.ResultAfterOtherContent])
  })
})

describe('a call and its result out of reach of each other', () => {
  it('faults a call with no following turn at all', () => {
    const assembled = exchange([user('go'), assistant([text('running it'), call('c0')])])
    const faults = exchangeFaults(assembled)

    expect(faults.map((entry) => entry.fault)).toEqual([EExchangeFault.UnansweredCall])
    expect(faults[0]).toMatchObject({ messageIndex: 1, toolCallId: 'c0' })
  })

  it('faults both ends when the result arrives two turns late', () => {
    const assembled = exchange([
      user('go'),
      assistant([call('c0')]),
      user('never mind'),
      assistant([text('as you wish')]),
      settlement([result('c0')]),
    ])

    expect(exchangeFaults(assembled).map((entry) => [entry.fault, entry.messageIndex])).toEqual([
      [EExchangeFault.UnansweredCall, 1],
      [EExchangeFault.UnmatchedResult, 4],
    ])
  })

  it('faults a result whose id no preceding call used', () => {
    const assembled = exchange([
      user('go'),
      assistant([call('c0')]),
      settlement([result('c0'), result('stray')]),
    ])
    const faults = exchangeFaults(assembled)

    expect(faults.map((entry) => entry.fault)).toEqual([EExchangeFault.UnmatchedResult])
    expect(faults[0]).toMatchObject({ toolCallId: 'stray' })
  })

  it('faults a result that opens the exchange with nothing to answer', () => {
    expect(kindsOf(exchange([settlement([result('c0')])]))).toEqual([
      EExchangeFault.UnmatchedResult,
    ])
  })
})

describe('content the provider rejects outright', () => {
  it('faults a message holding no parts', () => {
    const assembled = exchange([user('go'), assistant([])])
    const faults = exchangeFaults(assembled)

    expect(faults.map((entry) => entry.fault)).toEqual([EExchangeFault.EmptyContent])
    expect(faults[0]).toMatchObject({ messageIndex: 1, origin: originAt(1) })
  })

  it('faults a text part holding no text', () => {
    expect(kindsOf(exchange([user('')]))).toEqual([EExchangeFault.BlankText])
  })

  it('leaves a whitespace-only text part alone, which the provider is not known to refuse', () => {
    expect(kindsOf(exchange([user('   \n  ')]))).toEqual([])
    expect(kindsOf(exchange([user('go'), assistant([text('\t')])]))).toEqual([])
  })

  it('faults every empty text part in one message', () => {
    const assembled = exchange([
      user('go'),
      assistant([text(''), text('real'), text('')]),
    ])

    expect(kindsOf(assembled)).toEqual([EExchangeFault.BlankText, EExchangeFault.BlankText])
  })

  it('faults an exchange that opens with the assistant', () => {
    const faults = exchangeFaults(exchange([assistant([text('unprompted')])]))

    expect(faults.map((entry) => entry.fault)).toEqual([EExchangeFault.OpensWithAssistant])
    expect(faults[0]).toMatchObject({ messageIndex: 0, origin: originAt(0) })
  })
})

describe('an id used more than once', () => {
  it('faults the second call sharing an id, not the first', () => {
    const assembled = exchange([
      user('go'),
      assistant([call('c0')]),
      settlement([result('c0')]),
      assistant([call('c0')]),
      settlement([result('c0')]),
    ])
    const repeats = exchangeFaults(assembled).filter(
      (entry) => entry.fault === EExchangeFault.RepeatedCallId,
    )

    expect(repeats.map((entry) => entry.messageIndex)).toEqual([3])
  })

  it('faults a second result for one call', () => {
    const assembled = exchange([
      user('go'),
      assistant([call('c0')]),
      settlement([result('c0'), result('c0')]),
    ])

    expect(kindsOf(assembled)).toEqual([EExchangeFault.RepeatedResultId])
  })
})

describe('the report itself', () => {
  it('carries the origin of the message each fault sits on', () => {
    const faults = exchangeFaults(exchange([user(''), assistant([call('c0')])]))

    expect(faults.map((entry) => entry.origin)).toEqual([originAt(0), originAt(1)])
  })

  it('comes back in message order across different kinds of fault', () => {
    const assembled = exchange([
      assistant([call('c0')]),
      settlement([result('stray')]),
      assistant([]),
    ])

    expect(exchangeFaults(assembled).map((entry) => entry.messageIndex)).toEqual([0, 0, 1, 2])
  })
})
