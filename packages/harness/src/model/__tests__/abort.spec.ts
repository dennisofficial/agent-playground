import { describe, expect, it } from 'bun:test'

import {
  EFinishReason,
  toEventId,
  type Assembled,
  type ChunkFilter,
  type ProviderIdentity,
} from '@dltech/atlas-core'

import { createAiSdkModelPort } from '../ai-sdk-model-port'
import { interruptibleModel } from '../testing/interruptible-model'
import { raisingModel } from '../testing/raising-model'
import { scriptedModel } from '../testing/scripted-model'

const identity: ProviderIdentity = { id: 'anthropic', modelId: 'claude-opus-5' }

const assembled: Assembled = {
  system: [{ text: 'You are Atlas.' }],
  messages: [
    {
      message: { role: 'user', content: [{ type: 'text', text: 'what changed?' }] },
      origin: { eventId: toEventId('evt-1'), seq: 1 },
    },
  ],
}

const HEAD = 'auth and the router'
const TAIL = ' and everything else nobody waited for'

const abortOnFirstDelta =
  (controller: AbortController): ChunkFilter =>
  (chunk) => {
    if (chunk.type === 'text-delta') controller.abort()
    return chunk
  }

const stepWith = (args: {
  model: Parameters<typeof createAiSdkModelPort>[0]['model']
  signal: AbortSignal
  onChunk?: ChunkFilter
}) =>
  createAiSdkModelPort({ model: args.model, identity }).step({
    assembled,
    tools: [],
    signal: args.signal,
    ...(args.onChunk === undefined ? {} : { onChunk: args.onChunk }),
  })

describe('a stream the caller cut short', () => {
  it('returns the text that had already streamed rather than failing', async () => {
    const controller = new AbortController()

    const result = await stepWith({
      model: interruptibleModel({ head: HEAD, tail: TAIL }),
      signal: controller.signal,
      onChunk: abortOnFirstDelta(controller),
    })

    expect(result.parts).toEqual([{ type: 'text', text: HEAD }])
    expect(result.toolCalls).toEqual([])
  })

  it('claims no finish reason of its own for a turn that never finished', async () => {
    const controller = new AbortController()

    const result = await stepWith({
      model: interruptibleModel({ head: HEAD, tail: TAIL }),
      signal: controller.signal,
      onChunk: abortOnFirstDelta(controller),
    })

    expect(result.finishReason).toBe(EFinishReason.Other)
  })

  it('returns nothing at all when the signal was aborted before the call', async () => {
    const controller = new AbortController()
    controller.abort()

    const result = await stepWith({
      model: scriptedModel({ script: [{ text: 'unreachable' }] }),
      signal: controller.signal,
    })

    expect(result.parts).toEqual([])
  })
})

describe('a stream that raises rather than announcing the abort', () => {
  it('still returns the text that had already streamed', async () => {
    const controller = new AbortController()

    const result = await stepWith({
      model: raisingModel({ head: HEAD, error: new Error('socket closed'), waitFor: controller.signal }),
      signal: controller.signal,
      onChunk: abortOnFirstDelta(controller),
    })

    expect(result.parts).toEqual([{ type: 'text', text: HEAD }])
  })

  it('fails when nothing was aborted', async () => {
    const controller = new AbortController()

    const failing = stepWith({
      model: raisingModel({ head: HEAD, error: new Error('socket closed') }),
      signal: controller.signal,
    })

    await expect(failing).rejects.toThrow(/socket closed/)
  })
})
