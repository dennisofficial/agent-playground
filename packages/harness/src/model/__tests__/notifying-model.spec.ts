import {
  APICallError,
  type LanguageModelV4CallOptions,
  type LanguageModelV4GenerateResult,
  type LanguageModelV4StreamPart,
} from '@ai-sdk/provider'
import { MockLanguageModelV4 } from 'ai/test'
import { describe, expect, it } from 'bun:test'

import { createNotifyingModel, type ModelFault } from '../notifying-model'

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
}

const OPTIONS: LanguageModelV4CallOptions = {
  prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
}

const retryable = (): APICallError =>
  new APICallError({
    message: 'rate limited',
    url: 'https://api.anthropic.com/v1/messages',
    requestBodyValues: {},
    statusCode: 429,
    isRetryable: true,
  })

const generated = (text: string): LanguageModelV4GenerateResult => ({
  content: [{ type: 'text', text }],
  finishReason: { unified: 'stop', raw: undefined },
  usage: USAGE,
  warnings: [],
})

const streamOf = (chunks: LanguageModelV4StreamPart[]): ReadableStream<LanguageModelV4StreamPart> =>
  new ReadableStream<LanguageModelV4StreamPart>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })

const capture = async (pending: PromiseLike<unknown>): Promise<unknown> => {
  try {
    await pending
    return undefined
  } catch (error) {
    return error
  }
}

const collect = async (
  stream: ReadableStream<LanguageModelV4StreamPart>,
): Promise<LanguageModelV4StreamPart[]> => {
  const parts: LanguageModelV4StreamPart[] = []
  const reader = stream.getReader()

  for (;;) {
    const { done, value } = await reader.read()
    if (done) return parts
    parts.push(value)
  }
}

const textChunks = (text: string): LanguageModelV4StreamPart[] => [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 'text' },
  { type: 'text-delta', id: 'text', delta: text },
  { type: 'text-end', id: 'text' },
  {
    type: 'finish',
    usage: USAGE,
    finishReason: { unified: 'stop', raw: undefined },
  },
]

describe('createNotifyingModel', () => {
  it('passes provider and modelId through from the wrapped model', () => {
    const inner = new MockLanguageModelV4({ provider: 'anthropic', modelId: 'claude-haiku-4-5' })
    const wrapped = createNotifyingModel({ model: inner, onFault: () => {} })

    expect(wrapped.provider).toBe('anthropic')
    expect(wrapped.modelId).toBe('claude-haiku-4-5')
  })

  it('returns the doGenerate result untouched', async () => {
    const result = generated('done')
    const inner = new MockLanguageModelV4({ doGenerate: async () => result })
    const faults: ModelFault[] = []
    const wrapped = createNotifyingModel({ model: inner, onFault: (fault) => faults.push(fault) })

    const outcome = await wrapped.doGenerate(OPTIONS)

    expect(outcome).toBe(result)
    expect(faults).toEqual([])
  })

  it('reports a doGenerate rejection once and rethrows the identical error', async () => {
    const fault = retryable()
    const inner = new MockLanguageModelV4({
      provider: 'anthropic',
      modelId: 'claude-haiku-4-5',
      doGenerate: async () => {
        throw fault
      },
    })
    const faults: ModelFault[] = []
    const wrapped = createNotifyingModel({ model: inner, onFault: (f) => faults.push(f) })

    const caught = await capture(wrapped.doGenerate(OPTIONS))

    expect(caught).toBe(fault)
    expect(faults).toEqual([
      { providerId: 'anthropic', modelId: 'claude-haiku-4-5', fault },
    ])
  })

  it('rethrows the original error even when onFault throws', async () => {
    const fault = retryable()
    const inner = new MockLanguageModelV4({
      doGenerate: async () => {
        throw fault
      },
    })
    const wrapped = createNotifyingModel({
      model: inner,
      onFault: () => {
        throw new Error('notice store exploded')
      },
    })

    const caught = await capture(wrapped.doGenerate(OPTIONS))

    expect(caught).toBe(fault)
  })

  it('passes a successful stream through chunk for chunk, untouched', async () => {
    const chunks = textChunks('hello')
    const inner = new MockLanguageModelV4({ doStream: async () => ({ stream: streamOf(chunks) }) })
    const faults: ModelFault[] = []
    const wrapped = createNotifyingModel({ model: inner, onFault: (f) => faults.push(f) })

    const result = await wrapped.doStream(OPTIONS)
    const received = await collect(result.stream)

    expect(received).toHaveLength(chunks.length)
    for (const [index, chunk] of chunks.entries()) {
      expect(received[index]).toBe(chunk)
    }
    expect(faults).toEqual([])
  })

  it('reports a doStream rejection once and rethrows the identical error', async () => {
    const fault = retryable()
    const inner = new MockLanguageModelV4({
      provider: 'anthropic',
      modelId: 'claude-haiku-4-5',
      doStream: async () => {
        throw fault
      },
    })
    const faults: ModelFault[] = []
    const wrapped = createNotifyingModel({ model: inner, onFault: (f) => faults.push(f) })

    const caught = await capture(wrapped.doStream(OPTIONS))

    expect(caught).toBe(fault)
    expect(faults).toEqual([
      { providerId: 'anthropic', modelId: 'claude-haiku-4-5', fault },
    ])
  })

  it('reports a mid-stream error chunk once per call and still delivers it to the consumer', async () => {
    const fault = retryable()
    const errorChunk: LanguageModelV4StreamPart = { type: 'error', error: fault }
    const inner = new MockLanguageModelV4({
      provider: 'anthropic',
      modelId: 'claude-haiku-4-5',
      doStream: async () => ({ stream: streamOf([...textChunks('partial'), errorChunk]) }),
    })
    const faults: ModelFault[] = []
    const wrapped = createNotifyingModel({ model: inner, onFault: (f) => faults.push(f) })

    const received = await collect((await wrapped.doStream(OPTIONS)).stream)
    const second = await collect((await wrapped.doStream(OPTIONS)).stream)

    expect(received.at(-1)).toBe(errorChunk)
    expect(second.at(-1)).toBe(errorChunk)
    expect(faults).toEqual([
      { providerId: 'anthropic', modelId: 'claude-haiku-4-5', fault },
      { providerId: 'anthropic', modelId: 'claude-haiku-4-5', fault },
    ])
  })

  it('reports only the first error chunk when one stream carries several', async () => {
    const chunks = [
      ...textChunks('partial'),
      { type: 'error', error: retryable() },
      { type: 'error', error: retryable() },
    ] satisfies LanguageModelV4StreamPart[]
    const inner = new MockLanguageModelV4({ doStream: async () => ({ stream: streamOf(chunks) }) })
    const faults: ModelFault[] = []
    const wrapped = createNotifyingModel({ model: inner, onFault: (f) => faults.push(f) })

    await collect((await wrapped.doStream(OPTIONS)).stream)

    expect(faults).toHaveLength(1)
  })

  it('still delivers the error chunk when onFault throws on it', async () => {
    const fault = retryable()
    const errorChunk: LanguageModelV4StreamPart = { type: 'error', error: fault }
    const inner = new MockLanguageModelV4({
      doStream: async () => ({ stream: streamOf([...textChunks('partial'), errorChunk]) }),
    })
    const wrapped = createNotifyingModel({
      model: inner,
      onFault: () => {
        throw new Error('notice store exploded')
      },
    })

    const received = await collect((await wrapped.doStream(OPTIONS)).stream)

    expect(received.at(-1)).toBe(errorChunk)
  })
})
