import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'

import { providerPartsFor } from './scripted-model'

const DEFAULT_CHUNK_DELAY_MS = 5

export function interruptibleModel(args: {
  head: string
  tail: string
  chunkDelayInMs?: number
}): MockLanguageModelV4 {
  const parts = providerPartsFor({ text: args.head })
  const headIndex = parts.findIndex((part) => part.type === 'text-delta')
  const headDelta = parts[headIndex]
  if (headDelta === undefined || headDelta.type !== 'text-delta') {
    throw new Error('providerPartsFor no longer streams text as a delta')
  }

  parts.splice(headIndex + 1, 0, { type: 'text-delta', id: headDelta.id, delta: args.tail })

  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream<LanguageModelV4StreamPart>({
        chunks: parts,
        initialDelayInMs: 0,
        chunkDelayInMs: args.chunkDelayInMs ?? DEFAULT_CHUNK_DELAY_MS,
      }),
    }),
  })
}
