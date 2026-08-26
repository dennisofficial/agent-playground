import { describe, expect, it } from 'bun:test'

import {
  EStage,
  toEventId,
  type Assembled,
  type BeforeRequest,
  type Chunk,
  type ChunkFilter,
  type OnChunk,
} from '@dltech/atlas-core'

import { createHookRegistry, type HookRegistry } from '../../hooks/registry'
import { createAiSdkModelPort } from '../ai-sdk-model-port'
import { interruptibleModel } from '../testing/interruptible-model'
import { scriptedModel } from '../testing/scripted-model'

const identity = { id: 'anthropic', modelId: 'claude-opus-5' }

const assembled: Assembled = {
  system: [{ text: 'You are Atlas.' }],
  messages: [
    {
      message: { role: 'user', content: [{ type: 'text', text: 'what changed?' }] },
      origin: { eventId: toEventId('evt-1'), seq: 1 },
    },
  ],
}

const step = (args: {
  model: Parameters<typeof createAiSdkModelPort>[0]['model']
  hooks: HookRegistry
  onChunk?: ChunkFilter
}) =>
  createAiSdkModelPort({ model: args.model, identity, hooks: args.hooks }).step({
    assembled,
    tools: [],
    signal: new AbortController().signal,
    ...(args.onChunk ? { onChunk: args.onChunk } : {}),
  })

const instructing =
  (text: string): BeforeRequest =>
  async (prompt) => ({ ...prompt, instructions: [...prompt.instructions, { text }] })

describe('BeforeRequest', () => {
  it('rewrites the provider prompt in stage order, after conversion and before the call', async () => {
    const model = scriptedModel({ script: [{ text: 'auth' }] })

    await step({
      model,
      hooks: createHookRegistry({
        beforeRequest: [
          { name: 'observed', order: { stage: EStage.Observe, nudge: 0 }, run: instructing('observed') },
          { name: 'guarded', order: { stage: EStage.Guard, nudge: 0 }, run: instructing('guarded') },
        ],
      }),
    })

    expect(model.doStreamCalls[0]?.prompt.slice(0, 3)).toEqual([
      { role: 'system', content: 'You are Atlas.' },
      { role: 'system', content: 'guarded' },
      { role: 'system', content: 'observed' },
    ])
  })
})

const dropsLeaks: OnChunk = async (chunk) => {
  if (chunk.type === 'text-delta' && chunk.text.includes('sk-')) return null
  return chunk
}

const recordingInto = (seen: Chunk[]): OnChunk => async (chunk) => {
  seen.push(chunk)
  return chunk
}

describe('OnChunk', () => {
  it('drops a chunk a hook returned null for, and never lets a later hook see it', async () => {
    const logged: Chunk[] = []

    const result = await step({
      model: interruptibleModel({ head: 'safe ', tail: 'sk-leak', chunkDelayInMs: 0 }),
      hooks: createHookRegistry({
        onChunk: [
          { name: 'transcript-log', order: { stage: EStage.Observe, nudge: 0 }, run: recordingInto(logged) },
          { name: 'secret-redaction', order: { stage: EStage.Guard, nudge: 0 }, run: dropsLeaks },
        ],
      }),
    })

    expect(result.parts).toEqual([{ type: 'text', text: 'safe ' }])
    expect(logged.flatMap((chunk) => (chunk.type === 'text-delta' ? [chunk.text] : []))).toEqual(['safe '])
  })

  it('runs before the ChunkFilter the caller supplied, so a dropped chunk never reaches the UI', async () => {
    const published: Chunk[] = []
    const publish: ChunkFilter = (chunk) => {
      published.push(chunk)
      return chunk
    }

    await step({
      model: interruptibleModel({ head: 'safe ', tail: 'sk-leak', chunkDelayInMs: 0 }),
      hooks: createHookRegistry({
        onChunk: [{ name: 'secret-redaction', order: { stage: EStage.Guard, nudge: 0 }, run: dropsLeaks }],
      }),
      onChunk: publish,
    })

    expect(published.flatMap((chunk) => (chunk.type === 'text-delta' ? [chunk.text] : []))).toEqual(['safe '])
  })
})
