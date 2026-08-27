import { describe, expect, it } from 'bun:test'
import type { LanguageModelUsage, TextStreamPart, ToolSet } from 'ai'

import { EFinishReason } from '@dltech/atlas-core'

import { toCoreChunk } from '../chunk-conversion'

const usageOf = (args: {
  inputTokens?: number | undefined
  outputTokens?: number | undefined
  cacheReadTokens?: number | undefined
  cacheWriteTokens?: number | undefined
}): LanguageModelUsage => ({
  inputTokens: args.inputTokens,
  outputTokens: args.outputTokens,
  inputTokenDetails: {
    noCacheTokens: undefined,
    cacheReadTokens: args.cacheReadTokens,
    cacheWriteTokens: args.cacheWriteTokens,
  },
  outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
  totalTokens: undefined,
})

const finishPart = (totalUsage: LanguageModelUsage): TextStreamPart<ToolSet> => ({
  type: 'finish',
  finishReason: 'stop',
  rawFinishReason: undefined,
  totalUsage,
})

const usageOfChunk = (chunk: ReturnType<typeof toCoreChunk>) =>
  chunk?.type === 'finish' ? chunk.usage : undefined

describe('the usage a finished step reports', () => {
  it('carries the cache tiers, which bill at rates the prompt total cannot express', () => {
    const chunk = toCoreChunk(
      finishPart(
        usageOf({ inputTokens: 41_000, outputTokens: 900, cacheReadTokens: 39_000, cacheWriteTokens: 1_500 }),
      ),
    )

    expect(chunk).toEqual({
      type: 'finish',
      reason: EFinishReason.Stop,
      usage: {
        inputTokens: 41_000,
        outputTokens: 900,
        cacheReadTokens: 39_000,
        cacheWriteTokens: 1_500,
      },
    })
  })

  it('keeps the prompt total whole, since the tiers are a breakdown within it', () => {
    const chunk = toCoreChunk(
      finishPart(usageOf({ inputTokens: 1_000, outputTokens: 10, cacheReadTokens: 900, cacheWriteTokens: 50 })),
    )

    expect(usageOfChunk(chunk)?.inputTokens).toBe(1_000)
  })

  it('omits a tier the provider never reported rather than claiming it was zero', () => {
    const chunk = toCoreChunk(finishPart(usageOf({ inputTokens: 12, outputTokens: 3 })))

    expect(usageOfChunk(chunk)).toEqual({ inputTokens: 12, outputTokens: 3 })
  })

  it('reports a cache tier of zero as zero, which is not the same as never reported', () => {
    const chunk = toCoreChunk(
      finishPart(usageOf({ inputTokens: 12, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 })),
    )

    expect(usageOfChunk(chunk)).toEqual({
      inputTokens: 12,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
  })

  it('reports no usage at all when every count is missing', () => {
    expect(toCoreChunk(finishPart(usageOf({})))).toEqual({ type: 'finish', reason: EFinishReason.Stop })
  })
})
