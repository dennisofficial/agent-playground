import { describe, expect, it } from 'bun:test'
import { APICallError, type LanguageModelV4StreamPart } from '@ai-sdk/provider'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { z } from 'zod'

import {
  EFinishReason,
  EToolEffect,
  toCallId,
  toEventId,
  type Assembled,
  type AssembledMessage,
  type AssistantPart,
  type Chunk,
  type ChunkFilter,
  type ProviderIdentity,
  type ToolDeclaration,
} from '@dltech/atlas-core'

import { AiSdkModelPort } from '../ai-sdk-model-port'
import { ModelStreamError } from '../errors'
import { scriptedModel } from '../testing/scripted-model'

const cacheReportingModel = (tiers: {
  noCache: number
  cacheRead: number
  cacheWrite: number
  output: number
}): MockLanguageModelV4 =>
  new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream<LanguageModelV4StreamPart>({
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'cached' },
          { type: 'text-delta', id: 'cached', delta: 'answer' },
          { type: 'text-end', id: 'cached' },
          {
            type: 'finish',
            finishReason: { unified: 'stop', raw: undefined },
            usage: {
              inputTokens: {
                total: tiers.noCache + tiers.cacheRead + tiers.cacheWrite,
                noCache: tiers.noCache,
                cacheRead: tiers.cacheRead,
                cacheWrite: tiers.cacheWrite,
              },
              outputTokens: { total: tiers.output, text: tiers.output, reasoning: 0 },
            },
          },
        ],
        initialDelayInMs: 0,
        chunkDelayInMs: 0,
      }),
    }),
  })

const identity: ProviderIdentity = { id: 'anthropic', modelId: 'claude-opus-5' }

const userTurn: AssembledMessage = {
  message: { role: 'user', content: [{ type: 'text', text: 'what changed?' }] },
  origin: { eventId: toEventId('evt-1'), seq: 1 },
}

const assembledWith = (messages: readonly AssembledMessage[]): Assembled => ({
  system: [{ text: 'You are Atlas.' }],
  messages,
})

const readFile: ToolDeclaration = {
  name: 'read_file',
  description: 'read a file',
  effect: EToolEffect.Read,
  inputSchema: z.object({ path: z.string() }),
}

const step = (args: {
  model: ReturnType<typeof scriptedModel>
  assembled?: Assembled
  tools?: readonly ToolDeclaration[]
  onChunk?: ChunkFilter
}) => {
  const port = new AiSdkModelPort({ model: args.model, identity })
  return port.step({
    assembled: args.assembled ?? assembledWith([userTurn]),
    tools: args.tools ?? [],
    signal: new AbortController().signal,
    ...(args.onChunk ? { onChunk: args.onChunk } : {}),
  })
}

const overloadedOnce = (): { model: MockLanguageModelV4; calls: () => number } => {
  let calls = 0
  const model = new MockLanguageModelV4({
    doStream: async () => {
      calls += 1
      throw new APICallError({
        message: 'overloaded',
        url: 'https://api.anthropic.com/v1/messages',
        requestBodyValues: {},
        statusCode: 529,
        isRetryable: true,
      })
    },
  })
  return { model, calls: () => calls }
}

describe('who owns a retry', () => {
  it('leaves a retryable failure to the policy above instead of swallowing attempts', async () => {
    const overloaded = overloadedOnce()

    await expect(step({ model: overloaded.model })).rejects.toThrow()

    expect(overloaded.calls()).toBe(1)
  })
})

describe('AiSdkModelPort', () => {
  it('exposes the provider identity it was built with', () => {
    expect(new AiSdkModelPort({ model: scriptedModel({ script: [{ text: 'hi' }] }), identity }).identity).toEqual(
      identity,
    )
  })

  it('accumulates a scripted reasoning block and text into one turn', async () => {
    const result = await step({
      model: scriptedModel({ script: [{ reasoning: { text: 'checking the diff', signature: 'sig-abc' }, text: 'two files' }] }),
    })

    expect(result.parts).toEqual([
      { type: 'reasoning', text: 'checking the diff', providerOptions: { anthropic: { signature: 'sig-abc' } } },
      { type: 'text', text: 'two files' },
    ])
    expect(result.finishReason).toBe(EFinishReason.Stop)
  })

  it('hands the provider the instructions and the messages the prompt held', async () => {
    const model = scriptedModel({ script: [{ text: 'two files' }] })

    await step({ model })

    const prompt = model.doStreamCalls[0]?.prompt
    expect(prompt?.[0]).toEqual({ role: 'system', content: 'You are Atlas.' })
    expect(prompt?.[1]).toEqual({ role: 'user', content: [{ type: 'text', text: 'what changed?' }] })
  })

  it('surfaces an error chunk as a failure rather than an empty turn', async () => {
    const model = scriptedModel({ script: [{ error: 'overloaded_error' }] })

    await expect(step({ model })).rejects.toThrow(ModelStreamError)
  })

  it('names the model error it failed on', async () => {
    const model = scriptedModel({ script: [{ error: 'overloaded_error' }] })

    await expect(step({ model })).rejects.toThrow(/overloaded_error/)
  })

  it('keeps the provider error as the cause of the failure', async () => {
    const providerError = { type: 'overloaded_error' }
    const model = scriptedModel({ script: [{ error: providerError }] })

    const failure = await step({ model }).then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(ModelStreamError)
    expect(failure instanceof Error ? failure.cause : undefined).toBe(providerError)
  })

  it('does not report a turn at all when the stream errored after some text', async () => {
    const model = scriptedModel({ script: [{ text: 'partial', error: 'overloaded_error' }] })

    await expect(step({ model })).rejects.toThrow(ModelStreamError)
  })

  it('hands the error chunk on before it fails, so a subscriber is told why', async () => {
    const seen: Chunk[] = []
    const model = scriptedModel({ script: [{ error: 'overloaded_error' }] })

    await step({
      model,
      onChunk: (chunk) => {
        seen.push(chunk)
        return chunk
      },
    }).catch(() => undefined)

    expect(seen.filter((chunk) => chunk.type === 'error')).toEqual([
      { type: 'error', message: 'overloaded_error' },
    ])
  })

  it('hands the error chunk on after the text it interrupted', async () => {
    const seen: Chunk[] = []
    const model = scriptedModel({ script: [{ text: 'partial', error: 'overloaded_error' }] })

    await step({
      model,
      onChunk: (chunk) => {
        seen.push(chunk)
        return chunk
      },
    }).catch(() => undefined)

    expect(seen.map((chunk) => chunk.type)).toEqual(['text-start', 'text-delta', 'text-end', 'error'])
  })

  it('reports the tool calls the model asked for', async () => {
    const model = scriptedModel({
      script: [{ text: 'reading', calls: [{ callId: 'call-1', name: 'read_file', input: { path: 'a.ts' } }] }],
    })

    const result = await step({ model, tools: [readFile] })

    expect(result.toolCalls).toEqual([{ callId: toCallId('call-1'), name: 'read_file', input: { path: 'a.ts' } }])
    expect(result.finishReason).toBe(EFinishReason.ToolCalls)
  })

  it('reports the chunks it saw in stream order', async () => {
    const seen: Chunk[] = []

    await step({
      model: scriptedModel({ script: [{ reasoning: { text: 'thinking', signature: 'sig-abc' }, text: 'answer' }] }),
      onChunk: (chunk) => {
        seen.push(chunk)
        return chunk
      },
    })

    expect(seen.map((chunk) => chunk.type)).toEqual([
      'reasoning-start',
      'reasoning-delta',
      'reasoning-end',
      'text-start',
      'text-delta',
      'text-end',
      'finish',
    ])
  })

  it('carries the tokens the provider counted onto the finish chunk', async () => {
    const seen: Chunk[] = []

    await step({
      model: scriptedModel({
        script: [{ text: 'answer', usage: { inputTokens: 41_000, outputTokens: 900 } }],
      }),
      onChunk: (chunk) => {
        seen.push(chunk)
        return chunk
      },
    })

    expect(seen.find((chunk) => chunk.type === 'finish')).toEqual({
      type: 'finish',
      reason: EFinishReason.Stop,
      usage: { inputTokens: 41_000, outputTokens: 900, cacheReadTokens: 0, cacheWriteTokens: 0 },
    })
  })

  it('carries a cache read and a cache write through, since the two bill at different rates', async () => {
    const result = await step({
      model: cacheReportingModel({ noCache: 1_000, cacheRead: 38_000, cacheWrite: 2_000, output: 900 }),
    })

    expect(result.usage).toEqual({
      inputTokens: 41_000,
      outputTokens: 900,
      cacheReadTokens: 38_000,
      cacheWriteTokens: 2_000,
    })
  })

  it('hands the step its usage, so the loop can account for what the turn was billed', async () => {
    const result = await step({
      model: scriptedModel({
        script: [{ text: 'answer', usage: { inputTokens: 41_000, outputTokens: 900 } }],
      }),
    })

    expect(result.usage).toEqual({
      inputTokens: 41_000,
      outputTokens: 900,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
  })

  it('closes a block the stream left open', async () => {
    const result = await step({ model: scriptedModel({ script: [{ text: 'half an answ', leaveTextOpen: true }] }) })

    expect(result.parts).toEqual([{ type: 'text', text: 'half an answ' }])
  })

  it('carries a signature from one turn into the prompt of the next', async () => {
    const model = scriptedModel({
      script: [{ reasoning: { text: 'checking the diff', signature: 'sig-abc' }, text: 'two files' }, { text: 'and one more' }],
    })

    const first = await step({ model })
    const parts: readonly AssistantPart[] = first.parts

    await step({
      model,
      assembled: assembledWith([
        userTurn,
        {
          message: { role: 'assistant', content: parts },
          origin: { eventId: toEventId('evt-2'), seq: 2 },
        },
      ]),
    })

    const last = model.doStreamCalls[1]?.prompt.at(-1)
    if (last?.role !== 'assistant') throw new Error('expected the last prompt message to be the assistant turn')

    const reasoning = last.content.find((part) => part.type === 'reasoning')
    expect(reasoning?.providerOptions).toEqual({ anthropic: { signature: 'sig-abc' } })
  })
})
