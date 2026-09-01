import { describe, expect, it } from 'bun:test'
import type { ModelMessage } from 'ai'

import type { AssistantMessage, Message, ToolMessage, UserMessage } from '@dltech/atlas-core'

import { fromModelMessage, fromModelMessages, toModelMessage, toModelMessages } from '../message-conversion'

const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

const userSaid: UserMessage = {
  role: 'user',
  content: [{ type: 'text', text: 'what changed?', providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } }],
}

const assistantSaid: AssistantMessage = {
  role: 'assistant',
  content: [
    { type: 'reasoning', text: 'checking the diff', providerOptions: { anthropic: { signature: 'sig-abc' } } },
    { type: 'text', text: 'two files' },
    { type: 'tool-call', toolCallId: 'call-1', toolName: 'read_file', input: { path: 'a.ts' } },
  ],
  providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
}

const toolReported: ToolMessage = {
  role: 'tool',
  content: [
    { type: 'tool-result', toolCallId: 'call-1', toolName: 'read_file', output: { type: 'json', value: { lines: 12 } } },
  ],
}

describe('toModelMessage', () => {
  it('carries a user text part and its provider options through untouched', () => {
    expect(toModelMessage(userSaid)).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'what changed?', providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } }],
    })
  })

  it('carries a reasoning signature and a tool call through untouched', () => {
    expect(toModelMessage(assistantSaid)).toEqual({
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'checking the diff', providerOptions: { anthropic: { signature: 'sig-abc' } } },
        { type: 'text', text: 'two files' },
        { type: 'tool-call', toolCallId: 'call-1', toolName: 'read_file', input: { path: 'a.ts' } },
      ],
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    })
  })

  it('omits the provider options key entirely when there are none', () => {
    const converted = toModelMessage({ role: 'user', content: [{ type: 'text', text: 'hi' }] })
    const content = converted.content
    if (typeof content === 'string') throw new Error('expected the converted content to be parts')

    expect(Object.keys(converted)).toEqual(['role', 'content'])
    expect(Object.keys(content[0] ?? {})).toEqual(['type', 'text'])
  })

  it('carries a tool result output through untouched', () => {
    expect(toModelMessage(toolReported)).toEqual({
      role: 'tool',
      content: [
        { type: 'tool-result', toolCallId: 'call-1', toolName: 'read_file', output: { type: 'json', value: { lines: 12 } } },
      ],
    })
  })
})

describe('fromModelMessage', () => {
  it('round-trips every role back to the same value', () => {
    const messages: Message[] = [userSaid, assistantSaid, toolReported]

    expect(fromModelMessages(toModelMessages(messages))).toEqual(messages)
  })

  it('lifts a bare string user message into a single text part', () => {
    expect(fromModelMessage({ role: 'user', content: 'hello' })).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    })
  })

  it('lifts a bare string assistant message into a single text part', () => {
    expect(fromModelMessage({ role: 'assistant', content: 'hello' })).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
    })
  })

  it('refuses a system message, which belongs in instructions', () => {
    expect(() => fromModelMessage({ role: 'system', content: 'be brief' })).toThrow(/system/i)
  })

  it('refuses a remote image, which the event log cannot hold', () => {
    const withImage: ModelMessage = {
      role: 'user',
      content: [{ type: 'image', image: 'https://example.test/a.png' }],
    }

    expect(() => fromModelMessage(withImage)).toThrow(/image/i)
  })

  it('carries an inline image back into a core user message', () => {
    const withImage: ModelMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'what is broken here?' },
        { type: 'image', image: PIXEL, mediaType: 'image/png' },
      ],
    }

    expect(fromModelMessage(withImage)).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'what is broken here?' },
        { type: 'image', data: PIXEL, mediaType: 'image/png' },
      ],
    })
  })

  it('carries a mixed tool result back into a core tool message', () => {
    const withContentOutput: ModelMessage = {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'read_file',
          output: {
            type: 'content',
            value: [
              { type: 'text', text: 'Read image file [image/png] 1x1' },
              { type: 'file', data: { type: 'data', data: PIXEL }, mediaType: 'image/png' },
            ],
          },
        },
      ],
    }

    expect(fromModelMessage(withContentOutput)).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'read_file',
          output: {
            type: 'content',
            value: [
              { type: 'text', text: 'Read image file [image/png] 1x1' },
              { type: 'image', data: PIXEL, mediaType: 'image/png' },
            ],
          },
        },
      ],
    })
  })

  it('sends an image part out to the provider in the shape the SDK expects', () => {
    const sent = toModelMessage({
      role: 'user',
      content: [{ type: 'image', data: PIXEL, mediaType: 'image/png' }],
    })

    expect(sent).toEqual({
      role: 'user',
      content: [{ type: 'image', image: PIXEL, mediaType: 'image/png' }],
    })
  })

  it('sends a tool result image as an inline file, which is the SDK spelling', () => {
    const sent = toModelMessage({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'read',
          output: { type: 'content', value: [{ type: 'image', data: PIXEL, mediaType: 'image/png' }] },
        },
      ],
    })

    expect(sent).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'read',
          output: {
            type: 'content',
            value: [{ type: 'file', data: { type: 'data', data: PIXEL }, mediaType: 'image/png' }],
          },
        },
      ],
    })
  })
})
